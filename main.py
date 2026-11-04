import asyncio
import os
import pickle
from typing import Optional, List, Dict, Any, Tuple

import numpy as np
import pandas as pd
import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from dotenv import load_dotenv


# =========================
# ENV
# =========================
load_dotenv()
TMDB_API_KEY = os.getenv("TMDB_API_KEY")

TMDB_BASE = "https://api.themoviedb.org/3"
TMDB_IMG_500 = "https://image.tmdb.org/t/p/w500"

# Most of the dataset is obscure (median popularity ~1), and plain cosine
# similarity happily surfaces it. Keep recommendations to films people know.
MIN_REC_POPULARITY = 5.0
MAX_CONCURRENT_TMDB_LOOKUPS = 8

if not TMDB_API_KEY:
    # Don't crash import-time in production if you prefer; but for you better fail early:
    raise RuntimeError("TMDB_API_KEY missing. Put it in .env as TMDB_API_KEY=xxxx")


# =========================
# FASTAPI APP
# =========================
app = FastAPI(title="Movie Recommender API", version="3.0")


# =========================
# PICKLE GLOBALS
# =========================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

STATIC_DIR = os.path.join(BASE_DIR, "static")
INDEX_PATH = os.path.join(STATIC_DIR, "index.html")

PKL_DIR = os.path.join(BASE_DIR, "pkl")

DF_PATH = os.path.join(PKL_DIR, "df.pkl")
INDICES_PATH = os.path.join(PKL_DIR, "indices.pkl")
TFIDF_MATRIX_PATH = os.path.join(PKL_DIR, "tfidf_matrix.pkl")
TFIDF_PATH = os.path.join(PKL_DIR, "tfidf.pkl")

df: Optional[pd.DataFrame] = None
indices_obj: Any = None
tfidf_matrix: Any = None
tfidf_obj: Any = None

TITLE_TO_IDX: Optional[Dict[str, int]] = None

NORM_TITLES: Optional[np.ndarray] = None
POPULARITY: Optional[np.ndarray] = None
GENRE_SETS: Optional[List[set]] = None


# =========================
# MODELS
# =========================
class TMDBMovieCard(BaseModel):
    tmdb_id: int
    title: str
    poster_url: Optional[str] = None
    release_date: Optional[str] = None
    vote_average: Optional[float] = None


class TMDBMovieDetails(BaseModel):
    tmdb_id: int
    title: str
    overview: Optional[str] = None
    release_date: Optional[str] = None
    poster_url: Optional[str] = None
    backdrop_url: Optional[str] = None
    genres: List[dict] = []
    tagline: Optional[str] = None


class SimilarMoviesResponse(BaseModel):
    similar: List[TMDBMovieCard]
    more_like_this: List[TMDBMovieCard]


class TFIDFRecItem(BaseModel):
    title: str
    score: float
    tmdb: Optional[TMDBMovieCard] = None


class SearchBundleResponse(BaseModel):
    query: str
    movie_details: TMDBMovieDetails
    tfidf_recommendations: List[TFIDFRecItem]
    genre_recommendations: List[TMDBMovieCard]


# =========================
# UTILS
# =========================
def _norm_title(t: str) -> str:
    return str(t).strip().lower()


def make_img_url(path: Optional[str]) -> Optional[str]:
    if not path:
        return None
    return f"{TMDB_IMG_500}{path}"


async def tmdb_get(path: str, params: Dict[str, Any]) -> Dict[str, Any]:
    """
    Safe TMDB GET:
    - Network errors -> 502
    - TMDB API errors -> 502 with detail
    """
    q = dict(params)
    q["api_key"] = TMDB_API_KEY

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(f"{TMDB_BASE}{path}", params=q)
    except httpx.RequestError as e:
        raise HTTPException(
            status_code=502,
            detail=f"TMDB request error: {type(e).__name__} | {repr(e)}",
        )

    if r.status_code != 200:
        raise HTTPException(
            status_code=502, detail=f"TMDB error {r.status_code}: {r.text}"
        )

    return r.json()


async def tmdb_cards_from_results(
    results: List[dict], limit: int = 20
) -> List[TMDBMovieCard]:
    out: List[TMDBMovieCard] = []
    for m in (results or [])[:limit]:
        out.append(
            TMDBMovieCard(
                tmdb_id=int(m["id"]),
                title=m.get("title") or m.get("name") or "",
                poster_url=make_img_url(m.get("poster_path")),
                release_date=m.get("release_date"),
                vote_average=m.get("vote_average"),
            )
        )
    return out


async def tmdb_movie_details(movie_id: int) -> TMDBMovieDetails:
    data = await tmdb_get(f"/movie/{movie_id}", {"language": "en-US"})
    return TMDBMovieDetails(
        tmdb_id=int(data["id"]),
        title=data.get("title") or "",
        overview=data.get("overview"),
        release_date=data.get("release_date"),
        poster_url=make_img_url(data.get("poster_path")),
        backdrop_url=make_img_url(data.get("backdrop_path")),
        genres=data.get("genres", []) or [],
        tagline=data.get("tagline"),
    )


async def tmdb_search_movies(query: str, page: int = 1) -> Dict[str, Any]:
    """
    Raw TMDB response for keyword search (MULTIPLE results).
    The frontend uses this for suggestions and grid.
    """
    return await tmdb_get(
        "/search/movie",
        {
            "query": query,
            "include_adult": "false",
            "language": "en-US",
            "page": page,
        },
    )


async def tmdb_search_first(query: str) -> Optional[dict]:
    data = await tmdb_search_movies(query=query, page=1)
    results = data.get("results", [])
    return results[0] if results else None


# =========================
# TF-IDF Helpers
# =========================
def build_title_to_idx_map(indices: Any) -> Dict[str, int]:
    """
    indices.pkl can be:
    - dict(title -> index)
    - pandas Series (index=title, value=index)
    We normalize into TITLE_TO_IDX.
    """
    title_to_idx: Dict[str, int] = {}

    if isinstance(indices, dict):
        for k, v in indices.items():
            title_to_idx[_norm_title(k)] = int(v)
        return title_to_idx

    # pandas Series or similar mapping
    try:
        for k, v in indices.items():
            title_to_idx[_norm_title(k)] = int(v)
        return title_to_idx
    except Exception:
        # last resort: if it's a list-like etc.
        raise RuntimeError(
            "indices.pkl must be dict or pandas Series-like (with .items())"
        )


def get_local_idx_by_title(title: str) -> int:
    global TITLE_TO_IDX
    if TITLE_TO_IDX is None:
        raise HTTPException(status_code=500, detail="TF-IDF index map not initialized")
    key = _norm_title(title)
    if key in TITLE_TO_IDX:
        return int(TITLE_TO_IDX[key])
    raise HTTPException(
        status_code=404, detail=f"Title not found in local dataset: '{title}'"
    )


def tfidf_recommend_titles(
    query_title: str, top_n: int = 10
) -> List[Tuple[str, float]]:
    """
    Returns list of (title, score) from local df using cosine similarity on TF-IDF matrix.
    Safe against missing columns/rows.
    """
    global df, tfidf_matrix
    if df is None or tfidf_matrix is None:
        raise HTTPException(status_code=500, detail="TF-IDF resources not loaded")

    idx = get_local_idx_by_title(query_title)

    # query vector
    qv = tfidf_matrix[idx]
    scores = (tfidf_matrix @ qv.T).toarray().ravel()

    # sort descending
    order = np.argsort(-scores)

    out: List[Tuple[str, float]] = []
    for i in order:
        if int(i) == int(idx):
            continue
        try:
            title_i = str(df.iloc[int(i)]["title"])
        except Exception:
            continue
        out.append((title_i, float(scores[int(i)])))
        if len(out) >= top_n:
            break
    return out


def tfidf_recommend_for_movie(details: TMDBMovieDetails, top_n: int) -> List[str]:
    """
    Content-based titles for ANY movie, including ones newer than the dataset:
    vectorizes the movie's live TMDB text instead of looking its title up locally.
    Ranks by similarity weighted by popularity, within shared genres.
    """
    if tfidf_matrix is None or tfidf_obj is None:
        raise HTTPException(status_code=500, detail="TF-IDF resources not loaded")

    genre_names = [g["name"] for g in details.genres]
    # Same field recipe as df["tags"] in movies.ipynb.
    text = f"{details.overview or ''} {' '.join(genre_names)} {details.tagline or ''}"
    query_vector = tfidf_obj.transform([text])
    if query_vector.nnz == 0:
        return []

    scores = (tfidf_matrix @ query_vector.T).toarray().ravel()
    ranked = np.where(POPULARITY >= MIN_REC_POPULARITY, scores * np.log1p(POPULARITY), 0)

    source_genres = set(" ".join(genre_names).lower().split())
    seen = {_norm_title(details.title)}
    out: List[str] = []
    for i in np.argsort(-ranked):
        i = int(i)
        if ranked[i] <= 0:
            break
        if NORM_TITLES[i] in seen or (source_genres and not source_genres & GENRE_SETS[i]):
            continue
        seen.add(NORM_TITLES[i])
        out.append(str(df.iloc[i]["title"]))
        if len(out) >= top_n:
            break
    return out


async def exact_tmdb_card_by_title(
    title: str, semaphore: asyncio.Semaphore
) -> Optional[TMDBMovieCard]:
    """
    TMDB's search is fuzzy: "Hero" returns "Big Hero 6" first. Only accept an
    exact title match with a poster, so a card can't show the wrong movie.
    """
    try:
        async with semaphore:
            data = await tmdb_search_movies(query=title)
    except HTTPException:
        return None

    key = _norm_title(title)
    matches = [
        m
        for m in data.get("results", [])
        if _norm_title(m.get("title") or "") == key and m.get("poster_path")
    ]
    if not matches:
        return None
    best = max(matches, key=lambda m: m.get("popularity") or 0)
    return TMDBMovieCard(
        tmdb_id=int(best["id"]),
        title=best["title"],
        poster_url=make_img_url(best["poster_path"]),
        release_date=best.get("release_date"),
        vote_average=best.get("vote_average"),
    )


async def tmdb_related_cards(details: TMDBMovieDetails) -> List[TMDBMovieCard]:
    """TMDB's related movies, most relevant source first, posters only."""
    sources: List[Tuple[str, Dict[str, Any]]] = [
        (f"/movie/{details.tmdb_id}/recommendations", {"language": "en-US"}),
        (f"/movie/{details.tmdb_id}/similar", {"language": "en-US"}),
    ]
    if details.genres:
        sources.append(
            (
                "/discover/movie",
                {
                    "with_genres": details.genres[0]["id"],
                    "language": "en-US",
                    "sort_by": "popularity.desc",
                },
            )
        )

    for path, params in sources:
        try:
            data = await tmdb_get(path, params)
        except HTTPException:
            continue
        results = [m for m in data.get("results", []) if m.get("poster_path")]
        cards = await tmdb_cards_from_results(results, limit=len(results))
        if cards:
            return cards
    return []


async def attach_tmdb_card_by_title(title: str) -> Optional[TMDBMovieCard]:
    """
    Uses TMDB search by title to fetch poster for a local title.
    If not found, returns None (never crashes the endpoint).
    """
    try:
        m = await tmdb_search_first(title)
        if not m:
            return None
        return TMDBMovieCard(
            tmdb_id=int(m["id"]),
            title=m.get("title") or title,
            poster_url=make_img_url(m.get("poster_path")),
            release_date=m.get("release_date"),
            vote_average=m.get("vote_average"),
        )
    except Exception:
        return None


# =========================
# STARTUP: LOAD PICKLES
# =========================
@app.on_event("startup")
def load_pickles():
    global df, indices_obj, tfidf_matrix, tfidf_obj, TITLE_TO_IDX
    global NORM_TITLES, POPULARITY, GENRE_SETS

    # Load df
    with open(DF_PATH, "rb") as f:
        df = pickle.load(f)

    # Load indices
    with open(INDICES_PATH, "rb") as f:
        indices_obj = pickle.load(f)

    # Load TF-IDF matrix (usually scipy sparse)
    with open(TFIDF_MATRIX_PATH, "rb") as f:
        tfidf_matrix = pickle.load(f)

    # Load tfidf vectorizer (optional, not used directly here)
    with open(TFIDF_PATH, "rb") as f:
        tfidf_obj = pickle.load(f)

    # Build normalized map
    TITLE_TO_IDX = build_title_to_idx_map(indices_obj)

    # sanity
    if df is None or "title" not in df.columns:
        raise RuntimeError("df.pkl must contain a DataFrame with a 'title' column")

    NORM_TITLES = df["title"].map(_norm_title).to_numpy()
    POPULARITY = pd.to_numeric(df["popularity"], errors="coerce").fillna(0).to_numpy()
    # The dataset joins genre names with spaces, so compare genres word by word.
    GENRE_SETS = [set(str(genres).lower().split()) for genres in df["genres"].fillna("")]


# =========================
# ROUTES
# =========================
@app.get("/health")
def health():
    return {"status": "ok"}


# ---------- HOME FEED (TMDB) ----------
@app.get("/home", response_model=List[TMDBMovieCard])
async def home(
    category: str = Query("popular"),
    limit: int = Query(24, ge=1, le=50),
):
    """
    Home feed for the frontend (posters).
    category:
      - trending (trending/movie/day)
      - popular, top_rated, upcoming, now_playing  (movie/{category})
    """
    try:
        if category == "trending":
            data = await tmdb_get("/trending/movie/day", {"language": "en-US"})
            return await tmdb_cards_from_results(data.get("results", []), limit=limit)

        if category not in {"popular", "top_rated", "upcoming", "now_playing"}:
            raise HTTPException(status_code=400, detail="Invalid category")

        data = await tmdb_get(f"/movie/{category}", {"language": "en-US", "page": 1})
        return await tmdb_cards_from_results(data.get("results", []), limit=limit)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Home route failed: {e}")


# ---------- TMDB KEYWORD SEARCH (MULTIPLE RESULTS) ----------
@app.get("/tmdb/search")
async def tmdb_search(
    query: str = Query(..., min_length=1),
    page: int = Query(1, ge=1, le=10),
):
    """
    Returns RAW TMDB shape with 'results' list.
    The frontend uses it for:
      - dropdown suggestions
      - grid results
    """
    return await tmdb_search_movies(query=query, page=page)


# ---------- MOVIE DETAILS (SAFE ROUTE) ----------
@app.get("/movie/id/{tmdb_id}", response_model=TMDBMovieDetails)
async def movie_details_route(tmdb_id: int):
    return await tmdb_movie_details(tmdb_id)


# ---------- SIMILAR MOVIES (DETAILS PAGE) ----------
@app.get("/movie/id/{tmdb_id}/similar", response_model=SimilarMoviesResponse)
async def similar_movies_route(
    tmdb_id: int,
    limit: int = Query(12, ge=1, le=30),
):
    """
    - similar: content-based, from the TF-IDF model
    - more_like_this: TMDB's own related movies
    """
    details = await tmdb_movie_details(tmdb_id)

    # Some titles won't resolve to an exact TMDB match, so over-fetch.
    titles = tfidf_recommend_for_movie(details, top_n=limit * 2)
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_TMDB_LOOKUPS)
    resolved = await asyncio.gather(
        *(exact_tmdb_card_by_title(title, semaphore) for title in titles)
    )

    seen = {tmdb_id}
    similar: List[TMDBMovieCard] = []
    for card in resolved:
        if card and card.tmdb_id not in seen and len(similar) < limit:
            seen.add(card.tmdb_id)
            similar.append(card)

    more_like_this: List[TMDBMovieCard] = []
    for card in await tmdb_related_cards(details):
        if card.tmdb_id not in seen and len(more_like_this) < limit:
            seen.add(card.tmdb_id)
            more_like_this.append(card)

    # A movie with no overview gives TF-IDF nothing to work with.
    if not similar:
        similar, more_like_this = more_like_this, []

    return SimilarMoviesResponse(similar=similar, more_like_this=more_like_this)


# ---------- GENRE RECOMMENDATIONS ----------
@app.get("/recommend/genre", response_model=List[TMDBMovieCard])
async def recommend_genre(
    tmdb_id: int = Query(...),
    limit: int = Query(18, ge=1, le=50),
):
    """
    Given a TMDB movie ID:
    - fetch details
    - pick first genre
    - discover movies in that genre (popular)
    """
    details = await tmdb_movie_details(tmdb_id)
    if not details.genres:
        return []

    genre_id = details.genres[0]["id"]
    discover = await tmdb_get(
        "/discover/movie",
        {
            "with_genres": genre_id,
            "language": "en-US",
            "sort_by": "popularity.desc",
            "page": 1,
        },
    )
    cards = await tmdb_cards_from_results(discover.get("results", []), limit=limit)
    return [c for c in cards if c.tmdb_id != tmdb_id]


# ---------- TF-IDF ONLY (debug/useful) ----------
@app.get("/recommend/tfidf")
async def recommend_tfidf(
    title: str = Query(..., min_length=1),
    top_n: int = Query(10, ge=1, le=50),
):
    recs = tfidf_recommend_titles(title, top_n=top_n)
    return [{"title": t, "score": s} for t, s in recs]


# ---------- BUNDLE: Details + TF-IDF recs + Genre recs ----------
@app.get("/movie/search", response_model=SearchBundleResponse)
async def search_bundle(
    query: str = Query(..., min_length=1),
    tfidf_top_n: int = Query(12, ge=1, le=30),
    genre_limit: int = Query(12, ge=1, le=30),
):
    """
    This endpoint is for when you have a selected movie and want:
      - movie details
      - TF-IDF recommendations (local) + posters
      - Genre recommendations (TMDB) + posters

    NOTE:
    - It selects the BEST match from TMDB for the given query.
    - If you want MULTIPLE matches, use /tmdb/search
    """
    best = await tmdb_search_first(query)
    if not best:
        raise HTTPException(
            status_code=404, detail=f"No TMDB movie found for query: {query}"
        )

    tmdb_id = int(best["id"])
    details = await tmdb_movie_details(tmdb_id)

    # 1) TF-IDF recommendations (never crash endpoint)
    tfidf_items: List[TFIDFRecItem] = []

    recs: List[Tuple[str, float]] = []
    try:
        # try local dataset by TMDB title
        recs = tfidf_recommend_titles(details.title, top_n=tfidf_top_n)
    except Exception:
        # fallback to user query
        try:
            recs = tfidf_recommend_titles(query, top_n=tfidf_top_n)
        except Exception:
            recs = []

    for title, score in recs:
        card = await attach_tmdb_card_by_title(title)
        tfidf_items.append(TFIDFRecItem(title=title, score=score, tmdb=card))

    # 2) Genre recommendations (TMDB discover by first genre)
    genre_recs: List[TMDBMovieCard] = []
    if details.genres:
        genre_id = details.genres[0]["id"]
        discover = await tmdb_get(
            "/discover/movie",
            {
                "with_genres": genre_id,
                "language": "en-US",
                "sort_by": "popularity.desc",
                "page": 1,
            },
        )
        cards = await tmdb_cards_from_results(
            discover.get("results", []), limit=genre_limit
        )
        genre_recs = [c for c in cards if c.tmdb_id != details.tmdb_id]

    return SearchBundleResponse(
        query=query,
        movie_details=details,
        tfidf_recommendations=tfidf_items,
        genre_recommendations=genre_recs,
    )


# ---------- FRONTEND PAGES ----------
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index_page():
    return FileResponse(INDEX_PATH)


# Numeric IDs only, so this never shadows /movie/search or /movie/id/{tmdb_id}.
@app.get("/movie/{tmdb_id:int}", include_in_schema=False)
def movie_page(tmdb_id: int):
    return FileResponse(INDEX_PATH)
