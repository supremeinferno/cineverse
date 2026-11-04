// =============================
// CONFIG
// =============================
const TMDB_IMG = "https://image.tmdb.org/t/p/w500";
const SEARCH_DEBOUNCE_MS = 300;
const OVERVIEW_PREVIEW_CHARS = 220;

const app = document.getElementById("app");

// =============================
// HELPERS
// =============================
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function message(text, isError = false) {
    return el("div", isError ? "message error" : "message", text);
}

function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

async function apiGet(path, params = {}) {
    const url = new URL(path, window.location.origin);
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

function posterRing(cards, fallbackClass = "poster-rail") {
    if (!cards || !cards.length) return message("No movies to show.");

    const ring = el("div", "poster-ring");
    // Without WebGL, or if three.js can't be downloaded, posters still have to show.
    import("/static/three-mode.js")
        .then(({ mountCarousel }) => mountCarousel(ring, cards))
        .catch((err) => {
            console.error("3D Mode unavailable:", err);
            ring.replaceWith(flatPosters(cards, fallbackClass));
        });
    return ring;
}

function flatPosters(cards, className) {
    const container = el("div", className);
    for (const movie of cards) {
        const title = movie.title || "Untitled";
        const card = el("a", "poster-card");
        card.href = `/movie/${movie.tmdb_id}`;

        if (movie.poster_url) {
            const img = el("img");
            img.src = movie.poster_url;
            img.alt = title;
            img.loading = "lazy";
            card.append(img);
        } else {
            card.append(el("div", "poster-placeholder", "No poster"));
        }

        card.append(el("div", "movie-name", title));

        const sub = el("div", "movie-sub");
        if (movie.vote_average) sub.append(el("b", "", `★ ${movie.vote_average.toFixed(1)}`));
        const year = (movie.release_date || "").slice(0, 4);
        if (year) sub.append(`${movie.vote_average ? " · " : ""}${year}`);
        if (sub.hasChildNodes()) card.append(sub);

        container.append(card);
    }
    return container;
}

function parseTmdbSearch(data, keyword, limit = 24) {
    const items = (data.results || [])
        .filter((movie) => (movie.title || "").trim() && movie.id)
        .map((movie) => ({
            tmdb_id: movie.id,
            title: movie.title.trim(),
            poster_url: movie.poster_path ? `${TMDB_IMG}${movie.poster_path}` : null,
            release_date: movie.release_date || "",
            vote_average: movie.vote_average,
        }));

    const lowered = keyword.toLowerCase();
    const matched = items.filter((movie) => movie.title.toLowerCase().includes(lowered));
    const finalList = matched.length ? matched : items;

    const suggestions = finalList.slice(0, 8).map((movie) => {
        const year = movie.release_date.slice(0, 4);
        return { label: year ? `${movie.title} (${year})` : movie.title, tmdb_id: movie.tmdb_id };
    });
    return { suggestions, cards: finalList.slice(0, limit) };
}

// Home sections render after page load, so the browser can't jump to /#section itself.
function scrollToHash() {
    const target = window.location.hash && document.getElementById(window.location.hash.slice(1));
    if (target) target.scrollIntoView();
}

function setHeroBackdrop(hero, url) {
    if (url) hero.style.backgroundImage = `url("${url}")`;
}

// ==========================================================
// VIEW: HOME
// ==========================================================
const HOME_FEEDS = [
    { title: "Trending", category: "trending" },
    { title: "Top Rated", category: "top_rated" },
    { title: "Upcoming", category: "upcoming" },
    { title: "Now Playing", category: "now_playing" },
];

async function renderFeaturedHero(hero, cards) {
    if (!cards.length) return;
    const movie = await apiGet(`/movie/id/${cards[0].tmdb_id}`);
    setHeroBackdrop(hero, movie.backdrop_url);

    const text = el("div", "hero-text");
    const cta = el("a", "cta", "View details");
    cta.href = `/movie/${movie.tmdb_id}`;
    text.append(
        el("div", "eyebrow", "Trending today"),
        el("h1", "hero-title", movie.title),
        el("p", "hero-overview", truncate(movie.overview || "", OVERVIEW_PREVIEW_CHARS)),
        cta,
    );
    const content = el("div", "hero-content");
    content.append(text);
    hero.replaceChildren(content);
    // The hero's height can change once filled, moving the section being linked to.
    scrollToHash();
}

function renderHome() {
    document.title = "CineVerse";

    const input = document.getElementById("search-input");
    const suggestionsBox = document.getElementById("suggestions");
    const hero = el("section", "hero");
    const feeds = el("div", "sections");
    const results = el("div", "sections below-nav");
    results.hidden = true;
    app.append(hero, feeds, results);

    let feedsLoaded = false;
    const showFeeds = () => {
        results.hidden = true;
        results.replaceChildren();
        suggestionsBox.replaceChildren();
        hero.hidden = false;
        feeds.hidden = false;
        if (feedsLoaded) return;
        feedsLoaded = true;

        for (const feed of HOME_FEEDS) {
            const body = el("div");
            body.append(el("div", "skeleton"));
            const title = el("h2", "section-title", feed.title);
            title.id = feed.category;
            feeds.append(title, body);
            apiGet("/home", { category: feed.category, limit: 18 })
                .then((cards) => {
                    body.replaceChildren(posterRing(cards));
                    if (feed.category === "trending") return renderFeaturedHero(hero, cards);
                })
                .catch((err) => body.replaceChildren(message(`Could not load: ${err.message}`, true)));
        }
        scrollToHash();
    };

    // Responses can arrive out of order while typing; only the latest may render.
    let latestSearch = 0;
    const runSearch = async (query) => {
        const searchId = ++latestSearch;

        // Keep the query in the URL so the back button returns to these results.
        history.replaceState(null, "", query ? `/?q=${encodeURIComponent(query)}` : `/${window.location.hash}`);

        if (!query) return showFeeds();

        hero.hidden = true;
        feeds.hidden = true;
        results.hidden = false;
        if (query.length < 2) {
            suggestionsBox.replaceChildren();
            results.replaceChildren(message("Type at least 2 characters."));
            return;
        }

        try {
            const data = await apiGet("/tmdb/search", { query });
            if (searchId !== latestSearch) return;

            const { suggestions, cards } = parseTmdbSearch(data, query);
            suggestionsBox.replaceChildren(...suggestions.map((s) => {
                const link = el("a", "", s.label);
                link.href = `/movie/${s.tmdb_id}`;
                return link;
            }));
            results.replaceChildren(
                el("h2", "section-title", `Results for “${query}”`),
                posterRing(cards, "poster-grid"),
            );
        } catch (err) {
            if (searchId !== latestSearch) return;
            results.replaceChildren(message(`Search failed: ${err.message}`, true));
        }
    };

    let debounceTimer;
    input.addEventListener("input", () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => runSearch(input.value.trim()), SEARCH_DEBOUNCE_MS);
    });
    // Results are already live here; on other pages Enter submits to /?q=.
    input.form.addEventListener("submit", (event) => event.preventDefault());

    input.value = new URLSearchParams(window.location.search).get("q") || "";
    runSearch(input.value.trim());
}

// ==========================================================
// VIEW: DETAILS
// ==========================================================
async function renderDetails(tmdbId) {
    const loading = el("div", "sections below-nav");
    loading.append(el("div", "skeleton"));
    app.replaceChildren(loading);

    let data;
    try {
        data = await apiGet(`/movie/id/${tmdbId}`);
    } catch (err) {
        loading.replaceChildren(message(`Could not load details: ${err.message}`, true));
        return;
    }

    const title = data.title || "Movie";
    document.title = `${title} · CineVerse`;

    const hero = el("section", "hero");
    setHeroBackdrop(hero, data.backdrop_url);

    const content = el("div", "hero-content");
    if (data.poster_url) {
        const poster = el("img", "hero-poster");
        poster.src = data.poster_url;
        poster.alt = title;
        content.append(poster);
    }

    const meta = el("div", "meta");
    if (data.release_date) meta.append(el("span", "meta-date", data.release_date.slice(0, 4)));
    for (const genre of data.genres || []) meta.append(el("span", "chip", genre.name));

    const text = el("div", "hero-text");
    text.append(
        el("h1", "hero-title", title),
        meta,
        el("p", "hero-overview", data.overview || "No overview available."),
    );
    content.append(text);
    hero.append(content);

    const sections = el("div", "sections");
    const similar = el("div");
    similar.append(el("div", "skeleton"));
    sections.append(el("h2", "section-title", "Similar Movies"), similar);
    app.replaceChildren(hero, sections);

    try {
        const recs = await apiGet(`/movie/id/${tmdbId}/similar`, { limit: 12 });
        if (!recs.similar.length) {
            similar.replaceChildren(message("No similar movies found."));
            return;
        }
        similar.replaceChildren(posterRing(recs.similar));
        if (recs.more_like_this.length) {
            sections.append(
                el("h2", "section-title", "More Like This"),
                posterRing(recs.more_like_this),
            );
        }
    } catch (err) {
        similar.replaceChildren(message(`Could not load recommendations: ${err.message}`, true));
    }
}

// ==========================================================
// ROUTER
// ==========================================================
const movieMatch = window.location.pathname.match(/^\/movie\/(\d+)$/);
if (movieMatch) {
    renderDetails(movieMatch[1]);
} else {
    renderHome();
}
