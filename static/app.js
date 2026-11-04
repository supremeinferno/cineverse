// =============================
// CONFIG
// =============================
const TMDB_IMG = "https://image.tmdb.org/t/p/w500";
const SEARCH_DEBOUNCE_MS = 300;
const AMBIENT_FADE_MS = 1300;

const CATEGORIES = {
    trending: "Trending today",
    top_rated: "Top rated",
    upcoming: "Coming soon",
    now_playing: "Now playing",
};
const DEFAULT_CATEGORY = "trending";

const app = document.getElementById("app");
const ambient = document.getElementById("ambient");

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

async function apiGet(path, params = {}) {
    const url = new URL(path, window.location.origin);
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

function formatRuntime(minutes) {
    if (!minutes) return "";
    const hours = Math.floor(minutes / 60);
    return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function movieMeta(movie) {
    const parent = el("div", "movie-meta");
    if (movie.vote_average) parent.append(el("span", "rating", `★ ${movie.vote_average.toFixed(1)}`));
    const year = (movie.release_date || "").slice(0, 4);
    if (year) parent.append(el("span", "", year));
    const runtime = formatRuntime(movie.runtime);
    if (runtime) parent.append(el("span", "", runtime));
    return parent;
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
            overview: movie.overview,
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

// =============================
// AMBIENT BACKGROUND
// =============================
function setAmbient(url) {
    if (!url) return;
    const layer = new Image();
    layer.alt = "";
    layer.onload = () => {
        const previous = [...ambient.children];
        ambient.append(layer);
        requestAnimationFrame(() => layer.classList.add("on"));
        previous.forEach((old) => {
            old.classList.remove("on");
            setTimeout(() => old.remove(), AMBIENT_FADE_MS);
        });
    };
    layer.src = url;
}

// =============================
// STAGE: carousel + info panel
// =============================
function flatPosters(cards) {
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
            card.append(el("div", "poster-placeholder", "No poster"));
        }

        card.append(el("div", "movie-name", title), movieMeta(movie));
        grid.append(card);
    }
    return grid;
}

function movieStage(cards, { eyebrow = "", followAmbient = false } = {}) {
    if (!cards || !cards.length) return message("No movies to show.");

    const stage = el("section", "stage");
    const ring = el("div", "stage-ring");
    const panel = el("div", "stage-panel");

    const info = el("div", "stage-info");
    const title = el("h1", "stage-title");
    const meta = el("div");
    const overview = el("p", "stage-overview");
    info.append(el("div", "eyebrow", eyebrow), title, meta, overview);

    const cta = el("a", "cta", "View details");
    const counter = el("span", "stage-counter");
    const prev = el("button", "stage-arrow", "‹");
    const next = el("button", "stage-arrow", "›");
    prev.type = next.type = "button";
    prev.setAttribute("aria-label", "Previous movie");
    next.setAttribute("aria-label", "Next movie");

    const actions = el("div", "stage-actions");
    const controls = el("div", "stage-controls");
    controls.append(prev, counter, next);
    actions.append(cta, controls);
    panel.append(info, actions);
    stage.append(ring, panel);

    const showMovie = (movie, index) => {
        title.textContent = movie.title || "Untitled";
        meta.replaceChildren(movieMeta(movie));
        overview.textContent = movie.overview || "No overview available.";
        cta.href = `/movie/${movie.tmdb_id}`;
        counter.textContent = `${index + 1} / ${cards.length}`;
        info.getAnimations().forEach((animation) => animation.cancel());
        if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            info.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], {
                duration: 350,
                easing: "ease-out",
            });
        }
        if (followAmbient) setAmbient(movie.poster_url);
    };
    showMovie(cards[0], 0);

    // Without WebGL, or if three.js can't be downloaded, posters still have to show.
    import("/static/three-mode.js")
        .then(({ mountCarousel }) => {
            const carousel = mountCarousel(ring, cards, { onFocus: showMovie });
            if (!carousel) return;
            prev.addEventListener("click", () => carousel.rotateBy(-1));
            next.addEventListener("click", () => carousel.rotateBy(1));
        })
        .catch((err) => {
            console.error("3D carousel unavailable:", err);
            stage.replaceWith(flatPosters(cards));
        });

    return stage;
}

function stageSkeleton() {
    return el("div", "stage stage-skeleton");
}

// ==========================================================
// VIEW: HOME
// ==========================================================
function setActiveCategory(category) {
    for (const link of document.querySelectorAll(".nav-links a")) {
        if (link.dataset.category === category) {
            link.setAttribute("aria-current", "page");
        } else {
            link.removeAttribute("aria-current");
        }
    }
}

function categoryFromHash() {
    const category = window.location.hash.slice(1);
    return category in CATEGORIES ? category : DEFAULT_CATEGORY;
}

function renderHome() {
    const input = document.getElementById("search-input");
    const suggestionsBox = document.getElementById("suggestions");
    const view = el("div", "below-nav");
    app.replaceChildren(view);

    const feeds = new Map();
    const loadFeed = (category) => {
        if (!feeds.has(category)) {
            feeds.set(category, apiGet("/home", { category, limit: 18 }));
        }
        return feeds.get(category);
    };

    // Requests can finish out of order; only the latest may render.
    let latestRender = 0;

    const showCategory = async (category) => {
        const renderId = ++latestRender;
        document.title = "CineVerse";
        setActiveCategory(category);
        suggestionsBox.replaceChildren();
        view.replaceChildren(stageSkeleton());
        try {
            const cards = await loadFeed(category);
            if (renderId !== latestRender) return;
            view.replaceChildren(movieStage(cards, { eyebrow: CATEGORIES[category], followAmbient: true }));
        } catch (err) {
            if (renderId !== latestRender) return;
            feeds.delete(category);
            view.replaceChildren(message(`Could not load movies: ${err.message}`, true));
        }
    };

    const runSearch = async (query) => {
        // Keep the query in the URL so the back button returns to these results.
        history.replaceState(null, "", query ? `/?q=${encodeURIComponent(query)}` : `/${window.location.hash}`);

        if (!query) return showCategory(categoryFromHash());

        const renderId = ++latestRender;
        setActiveCategory(null);
        if (query.length < 2) {
            suggestionsBox.replaceChildren();
            view.replaceChildren(message("Type at least 2 characters."));
            return;
        }

        try {
            const data = await apiGet("/tmdb/search", { query });
            if (renderId !== latestRender) return;

            const { suggestions, cards } = parseTmdbSearch(data, query);
            suggestionsBox.replaceChildren(...suggestions.map((s) => {
                const link = el("a", "", s.label);
                link.href = `/movie/${s.tmdb_id}`;
                return link;
            }));
            view.replaceChildren(
                cards.length
                    ? movieStage(cards, { eyebrow: `Results for “${query}”`, followAmbient: true })
                    : message(`No movies found for “${query}”.`),
            );
        } catch (err) {
            if (renderId !== latestRender) return;
            view.replaceChildren(message(`Search failed: ${err.message}`, true));
        }
    };

    let debounceTimer;
    input.addEventListener("input", () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => runSearch(input.value.trim()), SEARCH_DEBOUNCE_MS);
    });
    // Results are already live here; on other pages Enter submits to /?q=.
    input.form.addEventListener("submit", (event) => event.preventDefault());

    window.addEventListener("hashchange", () => {
        clearTimeout(debounceTimer);
        input.value = "";
        showCategory(categoryFromHash());
    });

    input.value = new URLSearchParams(window.location.search).get("q") || "";
    runSearch(input.value.trim());
}

// ==========================================================
// VIEW: DETAILS
// ==========================================================
function recommendationTabs(tabs, body) {
    const bar = el("div", "rec-tabs");
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Recommendations");

    const select = (active) => {
        for (const { button, label } of tabs) {
            button.setAttribute("aria-pressed", String(label === active.label));
        }
        body.replaceChildren(movieStage(active.cards, { eyebrow: active.label }));
    };

    for (const tab of tabs) {
        tab.button = el("button", "rec-tab", tab.label);
        tab.button.type = "button";
        tab.button.addEventListener("click", () => select(tab));
        bar.append(tab.button);
    }
    return { bar, select };
}

async function renderDetails(tmdbId) {
    const loading = el("div", "below-nav");
    loading.append(stageSkeleton());
    app.replaceChildren(loading);

    let data;
    try {
        data = await apiGet(`/movie/id/${tmdbId}`);
    } catch (err) {
        loading.replaceChildren(message(`Could not load this movie: ${err.message}`, true));
        return;
    }

    const title = data.title || "Movie";
    document.title = `${title} · CineVerse`;
    setAmbient(data.poster_url);

    const hero = el("section", "hero");
    if (data.backdrop_url) hero.style.backgroundImage = `url("${data.backdrop_url}")`;

    const content = el("div", "hero-content");
    if (data.poster_url) {
        const poster = el("img", "hero-poster");
        poster.src = data.poster_url;
        poster.alt = title;
        content.append(poster);
    }

    const genres = el("div", "genres");
    for (const genre of data.genres || []) genres.append(el("span", "chip", genre.name));

    const text = el("div", "hero-text");
    text.append(el("h1", "hero-title", title), movieMeta(data));
    if (data.tagline) text.append(el("p", "hero-tagline", data.tagline));
    text.append(genres, el("p", "hero-overview", data.overview || "No overview available."));
    content.append(text);
    hero.append(content);

    const recommendations = el("div", "recommendations");
    const body = el("div");
    body.append(stageSkeleton());
    recommendations.append(body);
    app.replaceChildren(hero, recommendations);

    try {
        const recs = await apiGet(`/movie/id/${tmdbId}/similar`, { limit: 12 });
        if (!recs.similar.length) {
            body.replaceChildren(message("No similar movies found."));
            return;
        }
        const tabs = [{ label: "Similar Movies", cards: recs.similar }];
        if (recs.more_like_this.length) tabs.push({ label: "More Like This", cards: recs.more_like_this });
        const { bar, select } = recommendationTabs(tabs, body);
        recommendations.prepend(bar);
        select(tabs[0]);
    } catch (err) {
        body.replaceChildren(message(`Could not load recommendations: ${err.message}`, true));
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
