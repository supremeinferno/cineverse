// =============================
// CONFIG
// =============================
const TMDB_IMG = "https://image.tmdb.org/t/p/w500";
const SEARCH_DEBOUNCE_MS = 300;
const GRID_COLS_KEY = "cineverse.gridCols";
const THREE_MODE_KEY = "cineverse.threeMode";
const threeMode = localStorage.getItem(THREE_MODE_KEY) === "on";

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

function sectionTitle(text, spaced = true) {
    return el("div", spaced ? "section-title spaced" : "section-title", text);
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

function posterGrid(cards) {
    if (!cards || !cards.length) return message("No movies to show.");
    return threeMode ? posterRing(cards) : flatPosterGrid(cards);
}

function posterRing(cards) {
    const ring = el("div", "poster-ring");
    // Without WebGL, or if three.js can't be downloaded, fall back to the flat grid.
    import("/static/three-mode.js")
        .then(({ mountCarousel }) => mountCarousel(ring, cards))
        .catch((err) => {
            console.error("3D Mode unavailable:", err);
            ring.replaceWith(flatPosterGrid(cards));
        });
    return ring;
}

function flatPosterGrid(cards) {
    const grid = el("div", "poster-grid");
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
            card.append(el("div", "poster-placeholder", "🖼️ No poster"));
        }

        card.append(el("div", "button", "Open"), el("div", "movie-name", title));
        grid.append(card);
    }
    return grid;
}

function toCardsFromTfidfItems(items) {
    return (items || [])
        .filter((item) => item.tmdb && item.tmdb.tmdb_id)
        .map((item) => ({
            tmdb_id: item.tmdb.tmdb_id,
            title: item.tmdb.title || item.title,
            poster_url: item.tmdb.poster_url,
        }));
}

function parseTmdbSearch(data, keyword, limit = 24) {
    const items = (data.results || [])
        .filter((movie) => (movie.title || "").trim() && movie.id)
        .map((movie) => ({
            tmdb_id: movie.id,
            title: movie.title.trim(),
            poster_url: movie.poster_path ? `${TMDB_IMG}${movie.poster_path}` : null,
            release_date: movie.release_date || "",
        }));

    const lowered = keyword.toLowerCase();
    const matched = items.filter((movie) => movie.title.toLowerCase().includes(lowered));
    const finalList = matched.length ? matched : items;

    const suggestions = finalList.slice(0, 10).map((movie) => {
        const year = movie.release_date.slice(0, 4);
        return { label: year ? `${movie.title} (${year})` : movie.title, tmdb_id: movie.tmdb_id };
    });
    return { suggestions, cards: finalList.slice(0, limit) };
}

// =============================
// SIDEBAR
// =============================
function setupGridSlider() {
    const slider = document.getElementById("grid-cols");
    const value = document.getElementById("grid-cols-value");

    const apply = (cols) => {
        slider.value = cols;
        value.textContent = cols;
        document.documentElement.style.setProperty("--grid-cols", cols);
    };

    // Rows only exist in the flat grid.
    slider.disabled = threeMode;
    apply(localStorage.getItem(GRID_COLS_KEY) || 5);
    slider.addEventListener("input", () => {
        localStorage.setItem(GRID_COLS_KEY, slider.value);
        apply(slider.value);
    });
}

function setupThreeToggle() {
    const toggle = document.getElementById("three-mode");
    toggle.checked = threeMode;
    toggle.addEventListener("change", () => {
        localStorage.setItem(THREE_MODE_KEY, toggle.checked ? "on" : "off");
        window.location.reload();
    });
}

// ==========================================================
// VIEW: HOME
// ==========================================================
const HOME_FEEDS = [
    { title: "🔥 Trending", category: "trending" },
    { title: "⭐ Top Rated", category: "top_rated" },
    { title: "🎬 Upcoming", category: "upcoming" },
    { title: "🍿 Now Playing", category: "now_playing" },
];

function renderHome() {
    document.title = "CineVerse";

    const hero = el("div", "hero");
    hero.append(
        el("div", "hero-title", "CineVerse"),
        el("div", "hero-subtitle",
            "Discover trending films, timeless classics, hidden gems and personalized recommendations."),
    );

    const searchBox = el("div", "search-box");
    const input = el("input");
    input.type = "search";
    input.placeholder = "Search movies, actors, genres...";
    input.setAttribute("aria-label", "Search movies");
    searchBox.append(input);

    const results = el("div");
    const feeds = el("div");
    app.append(hero, sectionTitle("🔍 Discover Movies", false), searchBox, results, feeds);

    let feedsLoaded = false;
    const showFeeds = () => {
        results.replaceChildren();
        feeds.hidden = false;
        if (feedsLoaded) return;
        feedsLoaded = true;
        for (const feed of HOME_FEEDS) {
            const body = el("div");
            body.append(message("Loading…"));
            feeds.append(sectionTitle(feed.title), body);
            apiGet("/home", { category: feed.category, limit: 18 })
                .then((cards) => body.replaceChildren(posterGrid(cards)))
                .catch((err) => body.replaceChildren(message(`Could not load: ${err.message}`, true)));
        }
    };

    // Responses can arrive out of order while typing; only the latest may render.
    let latestSearch = 0;
    const runSearch = async (query) => {
        const searchId = ++latestSearch;

        // Keep the query in the URL so the back button returns to these results.
        const url = query ? `/?q=${encodeURIComponent(query)}` : "/";
        history.replaceState(null, "", url);

        if (!query) return showFeeds();

        feeds.hidden = true;
        if (query.length < 2) {
            results.replaceChildren(message("Type at least 2 characters."));
            return;
        }

        try {
            const data = await apiGet("/tmdb/search", { query });
            if (searchId !== latestSearch) return;

            const { suggestions, cards } = parseTmdbSearch(data, query);
            results.replaceChildren();

            if (suggestions.length) {
                const select = el("select", "suggestions");
                select.setAttribute("aria-label", "Suggestions");
                select.append(new Option("-- Select a Movie --", ""));
                for (const s of suggestions) select.append(new Option(s.label, s.tmdb_id));
                select.addEventListener("change", () => {
                    if (select.value) window.location.href = `/movie/${select.value}`;
                });
                results.append(select);
            }

            results.append(sectionTitle("🎬 Search Results"), posterGrid(cards));
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

    input.value = new URLSearchParams(window.location.search).get("q") || "";
    runSearch(input.value.trim());
}

// ==========================================================
// VIEW: DETAILS
// ==========================================================
async function renderDetails(tmdbId) {
    app.replaceChildren(message("Loading…"));

    let data;
    try {
        data = await apiGet(`/movie/id/${tmdbId}`);
    } catch (err) {
        app.replaceChildren(message(`Could not load details: ${err.message}`, true));
        return;
    }

    const title = data.title || "Movie";
    const overview = data.overview || "No overview available.";
    document.title = `${title} · CineVerse`;
    app.replaceChildren();

    if (data.backdrop_url) {
        const hero = el("div", "hero");
        hero.style.minHeight = "480px";
        hero.style.backgroundImage = `
            radial-gradient(ellipse 900px 500px at 20% 30%, rgba(250,45,72,.14), transparent 60%),
            linear-gradient(rgba(0,0,0,.35), rgba(0,0,0,.94)),
            url("${data.backdrop_url}")`;
        hero.append(el("div", "hero-title", title), el("div", "hero-subtitle", overview.slice(0, 300)));
        app.append(hero);
    }

    const actions = el("div", "details-actions");
    const homeLink = el("a", "button", "🏠 Home");
    homeLink.href = "/";
    actions.append(homeLink);
    app.append(actions);

    const details = el("div", "details");
    const posterColumn = el("div");
    if (data.poster_url) {
        const poster = el("img", "details-poster");
        poster.src = data.poster_url;
        poster.alt = title;
        posterColumn.append(poster);
    }

    const info = el("div", "movie-info-card");
    info.append(
        el("h1", "", data.title || ""),
        el("div", "movie-release", `📅 ${data.release_date || "-"}`),
        el("div", "movie-genres", `🎭 ${(data.genres || []).map((g) => g.name).join(", ")}`),
        el("div", "movie-overview", overview),
    );
    details.append(posterColumn, info);
    app.append(details);

    app.append(sectionTitle("🔎 Similar Movies"));
    const similar = el("div");
    similar.append(message("Loading recommendations…"));
    app.append(similar);

    const query = (data.title || "").trim();
    if (!query) {
        similar.replaceChildren(message("No recommendations available."));
        return;
    }

    try {
        const bundle = await apiGet("/movie/search", { query, tfidf_top_n: 12, genre_limit: 12 });
        similar.replaceChildren(posterGrid(toCardsFromTfidfItems(bundle.tfidf_recommendations)));
        app.append(sectionTitle("🎭 More Like This"), posterGrid(bundle.genre_recommendations));
    } catch {
        try {
            const genreOnly = await apiGet("/recommend/genre", { tmdb_id: tmdbId, limit: 18 });
            similar.replaceChildren(posterGrid(genreOnly));
        } catch {
            similar.replaceChildren(message("No recommendations available."));
        }
    }
}

// ==========================================================
// ROUTER
// ==========================================================
setupGridSlider();
setupThreeToggle();

const movieMatch = window.location.pathname.match(/^\/movie\/(\d+)$/);
if (movieMatch) {
    renderDetails(movieMatch[1]);
} else {
    renderHome();
}
