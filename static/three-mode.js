// =============================
// 3D MODE — Three.js poster carousels
// Loaded on demand by app.js, only while 3D Mode is switched on.
// =============================
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js";

const POSTER_W = 2;
const POSTER_H = 3;
const POSTER_GAP = 0.4;
const CORNER = 0.12;
const MIN_RADIUS = 3;
const MIN_VISIBLE_WIDTH = 4;
const CAMERA_DISTANCE = 5;
const FOV = 45;
const AUTO_SPIN = 0.0025;
const DRAG_SPEED = 0.006;
const FRICTION = 0.94;
const CLICK_TOLERANCE_PX = 5;
const MIN_AUTO_SPIN_POSTERS = 6;

function posterGeometry() {
    const [w, h, r] = [POSTER_W / 2, POSTER_H / 2, CORNER];
    const shape = new THREE.Shape();
    shape.moveTo(-w + r, -h);
    shape.lineTo(w - r, -h);
    shape.quadraticCurveTo(w, -h, w, -h + r);
    shape.lineTo(w, h - r);
    shape.quadraticCurveTo(w, h, w - r, h);
    shape.lineTo(-w + r, h);
    shape.quadraticCurveTo(-w, h, -w, h - r);
    shape.lineTo(-w, -h + r);
    shape.quadraticCurveTo(-w, -h, -w + r, -h);

    // ShapeGeometry's UVs are raw x/y; remap them so the texture fills the card.
    const geometry = new THREE.ShapeGeometry(shape, 6);
    const { position, uv } = geometry.attributes;
    for (let i = 0; i < position.count; i++) {
        uv.setXY(i, (position.getX(i) + w) / POSTER_W, (position.getY(i) + h) / POSTER_H);
    }
    return geometry;
}

function placeholderTexture(title) {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 384;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#1e1a28";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#b3abbd";
    ctx.font = "600 22px Inter, sans-serif";
    ctx.textAlign = "center";

    const lines = [];
    let line = "";
    for (const word of title.split(" ")) {
        const next = line ? `${line} ${word}` : word;
        if (ctx.measureText(next).width > 216 && line) {
            lines.push(line);
            line = word;
        } else {
            line = next;
        }
    }
    lines.push(line);
    lines.forEach((text, i) => {
        ctx.fillText(text, canvas.width / 2, canvas.height / 2 + (i - lines.length / 2) * 28);
    });

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

// Builds a carousel inside `container`. It disposes itself (freeing its WebGL
// context) once the container leaves the page, e.g. when a new search renders.
export function mountCarousel(container, cards) {
    // The view already moved on while three.js was downloading.
    if (!container.isConnected) return;

    const count = cards.length;
    const step = (Math.PI * 2) / count;
    const radius = Math.max((count * (POSTER_W + POSTER_GAP)) / (Math.PI * 2), MIN_RADIUS);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // With only a few posters, spinning leaves the ring looking empty.
    const autoSpin = !reducedMotion && count >= MIN_AUTO_SPIN_POSTERS;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.append(renderer.domElement);

    const caption = document.createElement("div");
    caption.className = "ring-caption";
    caption.setAttribute("aria-hidden", "true");
    const captionTitle = document.createElement("div");
    captionTitle.className = "ring-caption-title";
    const captionMeta = document.createElement("div");
    captionMeta.className = "ring-caption-meta";
    caption.append(captionTitle, captionMeta);
    container.append(caption);

    // The canvas is invisible to screen readers, so mirror the movies as links.
    const movieLinks = document.createElement("ul");
    movieLinks.className = "sr-only";
    for (const movie of cards) {
        const item = document.createElement("li");
        const link = document.createElement("a");
        link.href = `/movie/${movie.tmdb_id}`;
        link.textContent = movie.title || "Untitled";
        link.tabIndex = -1;
        item.append(link);
        movieLinks.append(item);
    }
    container.append(movieLinks);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x110e17);
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);

    const ring = new THREE.Group();
    scene.add(ring);

    const geometry = posterGeometry();
    const loader = new THREE.TextureLoader();
    const textures = [];
    const meshes = cards.map((movie, i) => {
        const title = movie.title || "Untitled";
        const texture = placeholderTexture(title);
        textures.push(texture);

        const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true });
        const mesh = new THREE.Mesh(geometry, material);
        const angle = i * step;
        mesh.position.set(Math.sin(angle) * radius, 0, Math.cos(angle) * radius);
        mesh.rotation.y = angle;
        const year = (movie.release_date || "").slice(0, 4);
        const rating = movie.vote_average ? `★ ${movie.vote_average.toFixed(1)}` : "";
        mesh.userData = {
            href: `/movie/${movie.tmdb_id}`,
            title,
            meta: [rating, year].filter(Boolean).join(" · "),
        };
        ring.add(mesh);

        if (movie.poster_url) {
            // Flat mode caches posters from plain <img> requests, without the CORS
            // headers WebGL needs. A distinct URL keeps this from reusing that copy.
            loader.load(`${movie.poster_url}?cors=1`, (loaded) => {
                if (disposed) return loaded.dispose();
                loaded.colorSpace = THREE.SRGBColorSpace;
                loaded.anisotropy = renderer.capabilities.getMaxAnisotropy();
                textures.push(loaded);
                material.map = loaded;
                material.needsUpdate = true;
            });
        }
        return mesh;
    });

    function resize() {
        const width = container.clientWidth;
        const height = container.clientHeight;
        if (!width || !height) return;
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        // Back the camera up on narrow screens so posters don't get cropped.
        const fit = MIN_VISIBLE_WIDTH / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * camera.aspect);
        const distance = Math.max(CAMERA_DISTANCE, fit);
        camera.position.set(0, 0, radius + distance);
        scene.fog.near = distance + radius * 0.4;
        scene.fog.far = distance + radius * 1.1;
        camera.updateProjectionMatrix();
    }
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    let onScreen = true;
    const visibilityObserver = new IntersectionObserver(([entry]) => {
        onScreen = entry.isIntersecting;
    });
    visibilityObserver.observe(container);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    function meshAt(event) {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
        );
        raycaster.setFromCamera(pointer, camera);
        return raycaster.intersectObjects(meshes)[0]?.object || null;
    }

    // The poster currently turned closest to the camera.
    function frontMesh() {
        const index = Math.round(-ring.rotation.y / step);
        return meshes[((index % count) + count) % count];
    }

    let dragging = false;
    let hovered = null;
    let velocity = 0;
    let targetRotation = null;
    let dragStartX = 0;
    let lastX = 0;

    function rotateBy(direction) {
        targetRotation = (Math.round(ring.rotation.y / step) + direction) * step;
        velocity = 0;
    }

    for (const [label, symbol, direction, side] of [
        ["Previous movie", "‹", 1, "prev"],
        ["Next movie", "›", -1, "next"],
    ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `ring-arrow ${side}`;
        button.setAttribute("aria-label", label);
        button.textContent = symbol;
        button.addEventListener("click", () => rotateBy(direction));
        container.append(button);
    }

    const canvas = renderer.domElement;
    canvas.addEventListener("pointerdown", (event) => {
        dragging = true;
        targetRotation = null;
        velocity = 0;
        dragStartX = lastX = event.clientX;
        canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
        if (dragging) {
            velocity = (event.clientX - lastX) * DRAG_SPEED;
            ring.rotation.y += velocity;
            lastX = event.clientX;
        } else {
            hovered = meshAt(event);
            canvas.style.cursor = hovered ? "pointer" : "grab";
        }
    });
    canvas.addEventListener("pointerup", (event) => {
        dragging = false;
        if (Math.abs(event.clientX - dragStartX) < CLICK_TOLERANCE_PX) {
            const hit = meshAt(event);
            if (hit) window.location.href = hit.userData.href;
        }
    });
    canvas.addEventListener("pointercancel", () => { dragging = false; });
    canvas.addEventListener("pointerleave", () => { hovered = null; });

    container.tabIndex = 0;
    container.setAttribute("role", "group");
    container.setAttribute("aria-label", "3D movie carousel. Left and right arrows browse, Enter opens.");
    container.addEventListener("keydown", (event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            rotateBy(event.key === "ArrowLeft" ? 1 : -1);
        } else if (event.key === "Enter") {
            window.location.href = frontMesh().userData.href;
        }
    });

    let disposed = false;
    function dispose() {
        disposed = true;
        renderer.setAnimationLoop(null);
        resizeObserver.disconnect();
        visibilityObserver.disconnect();
        geometry.dispose();
        textures.forEach((texture) => texture.dispose());
        meshes.forEach((mesh) => mesh.material.dispose());
        renderer.dispose();
        renderer.forceContextLoss();
    }

    renderer.setAnimationLoop(() => {
        if (!container.isConnected) return dispose();
        if (!onScreen) return;

        const focused = document.activeElement === container;
        if (targetRotation !== null) {
            ring.rotation.y += (targetRotation - ring.rotation.y) * 0.12;
            if (Math.abs(targetRotation - ring.rotation.y) < 0.001) targetRotation = null;
        } else if (!dragging) {
            velocity *= FRICTION;
            ring.rotation.y += velocity;
            if (!hovered && !focused && autoSpin) ring.rotation.y += AUTO_SPIN;
        }

        for (const mesh of meshes) {
            const scale = mesh === hovered ? 1.08 : 1;
            mesh.scale.setScalar(mesh.scale.x + (scale - mesh.scale.x) * 0.15);
        }

        const { title, meta } = (hovered || frontMesh()).userData;
        if (captionTitle.textContent !== title) {
            captionTitle.textContent = title;
            captionMeta.textContent = meta;
        }
        renderer.render(scene, camera);
    });
}
