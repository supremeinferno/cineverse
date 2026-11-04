// =============================
// 3D poster carousel (Three.js)
// Loaded on demand by app.js.
// =============================
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js";

const POSTER_W = 2;
const POSTER_H = 3;
const POSTER_GAP = 0.45;
const CORNER = 0.1;
const MIN_RADIUS = 3;
const MIN_VISIBLE_WIDTH = 4;
const CAMERA_DISTANCE = 5.4;
const FOV = 45;
const WIDE_LAYOUT_PX = 900;
const AUTO_ADVANCE_MS = 5500;
const ROTATION_EASE = 0.09;
const DRAG_SPEED = 0.006;
const FLICK_PROJECTION = 6;
const CLICK_TOLERANCE_PX = 5;

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

// Builds a carousel inside `container` and calls onFocus(movie, index) whenever a
// new poster reaches the front. It disposes itself (freeing its WebGL context)
// once the container leaves the page, e.g. when the category changes.
export function mountCarousel(container, cards, { onFocus }) {
    // The view already moved on while three.js was downloading.
    if (!container.isConnected) return null;

    const count = cards.length;
    const step = (Math.PI * 2) / count;
    const radius = Math.max((count * (POSTER_W + POSTER_GAP)) / (Math.PI * 2), MIN_RADIUS);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.append(renderer.domElement);

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
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);

    const ring = new THREE.Group();
    scene.add(ring);

    let disposed = false;
    const geometry = posterGeometry();
    const loader = new THREE.TextureLoader();
    const textures = [];
    const meshes = cards.map((movie, i) => {
        const texture = placeholderTexture(movie.title || "Untitled");
        textures.push(texture);

        const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
        const mesh = new THREE.Mesh(geometry, material);
        const angle = i * step;
        mesh.position.set(Math.sin(angle) * radius, 0, Math.cos(angle) * radius);
        mesh.rotation.y = angle;
        mesh.userData = { index: i, angle, href: `/movie/${movie.tmdb_id}` };
        ring.add(mesh);

        if (movie.poster_url) {
            // Plain <img> tags cache posters without the CORS headers WebGL needs.
            // A distinct URL keeps this request from reusing that copy.
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
        camera.position.set(0, 0, radius + Math.max(CAMERA_DISTANCE, fit));
        // On wide screens the info panel sits left, so centre the ring in the space right of it.
        if (width >= WIDE_LAYOUT_PX) {
            camera.setViewOffset(width, height, -width * 0.2, 0, width, height);
        } else {
            camera.clearViewOffset();
        }
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
        const facingCamera = raycaster.intersectObjects(meshes)
            .filter((hit) => Math.cos(hit.object.userData.angle + ring.rotation.y) > 0);
        return facingCamera[0]?.object || null;
    }

    const frontIndex = () => {
        const index = Math.round(-ring.rotation.y / step);
        return ((index % count) + count) % count;
    };

    let target = 0;
    let dragging = false;
    let hovered = null;
    let velocity = 0;
    let dragStartX = 0;
    let lastX = 0;
    let idleMs = 0;

    function rotateBy(direction) {
        target = (Math.round(target / step) - direction) * step;
        idleMs = 0;
    }

    // Takes the short way round to the poster that was clicked.
    function bringToFront(mesh) {
        const current = mesh.userData.angle + target;
        target -= Math.atan2(Math.sin(current), Math.cos(current));
        idleMs = 0;
    }

    const canvas = renderer.domElement;
    canvas.addEventListener("pointerdown", (event) => {
        dragging = true;
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
        idleMs = 0;
        if (Math.abs(event.clientX - dragStartX) < CLICK_TOLERANCE_PX) {
            target = ring.rotation.y;
            const hit = meshAt(event);
            if (!hit) {
                target = Math.round(target / step) * step;
            } else if (hit.userData.index === frontIndex()) {
                window.location.href = hit.userData.href;
            } else {
                bringToFront(hit);
            }
            return;
        }
        // Let a flick carry on, then settle with a poster squarely at the front.
        target = Math.round((ring.rotation.y + velocity * FLICK_PROJECTION) / step) * step;
    });
    canvas.addEventListener("pointercancel", () => {
        dragging = false;
        target = Math.round(ring.rotation.y / step) * step;
    });
    canvas.addEventListener("pointerleave", () => { hovered = null; });

    container.tabIndex = 0;
    container.setAttribute("role", "group");
    container.setAttribute("aria-label", "3D movie carousel. Left and right arrows browse, Enter opens.");
    container.addEventListener("keydown", (event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            rotateBy(event.key === "ArrowLeft" ? -1 : 1);
        } else if (event.key === "Enter") {
            window.location.href = meshes[frontIndex()].userData.href;
        }
    });

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

    let focused = -1;
    let lastFrame = performance.now();
    renderer.setAnimationLoop((now) => {
        if (!container.isConnected) return dispose();
        const elapsed = now - lastFrame;
        lastFrame = now;
        if (!onScreen) return;

        if (!dragging) {
            ring.rotation.y += (target - ring.rotation.y) * ROTATION_EASE;

            const paused = hovered || reducedMotion || count < 2 || document.activeElement === container;
            idleMs = paused ? 0 : idleMs + elapsed;
            if (idleMs >= AUTO_ADVANCE_MS) rotateBy(1);
        }

        for (const mesh of meshes) {
            // 1 when facing the camera, 0 side-on: posters fade out towards the back.
            const facing = Math.max(0, Math.cos(mesh.userData.angle + ring.rotation.y));
            mesh.material.opacity = Math.min(1, facing * 3);
            mesh.material.color.setScalar(0.3 + 0.7 * facing ** 4);
            const scale = 1 + 0.05 * facing ** 8 + (mesh === hovered ? 0.03 : 0);
            mesh.scale.setScalar(mesh.scale.x + (scale - mesh.scale.x) * 0.15);
        }

        const front = frontIndex();
        if (front !== focused) {
            focused = front;
            onFocus(cards[front], front);
        }
        renderer.render(scene, camera);
    });

    return { rotateBy };
}
