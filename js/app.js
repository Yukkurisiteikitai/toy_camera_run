// --- 設定と初期化 ---
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const renderer = new THREE.WebGLRenderer({
    antialias: false,
    alpha: false,
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio); // 高解像度対応
document.body.appendChild(renderer.domElement);

const clock = new THREE.Clock();

// 画面全体を覆う平面
const geometry = new THREE.PlaneGeometry(2, 2);

// --- ビデオ入力の準備 ---
const video = document.createElement("video");
video.autoplay = true;
video.muted = true;
video.loop = true;
video.setAttribute("playsinline", "");

let videoTexture;
let rtVideoPrev;
let isCameraReady = false;
let cameraStream = null;
let loadedVideoUrl = null;

const loadingEl = document.getElementById("loading");
const menuButton = document.getElementById("menu-button");
const controlsPanel = document.getElementById("controls");
const videoFileInput = document.getElementById("video-file");
const inkColorInput = document.getElementById("ink-color");
const colorMixInput = document.getElementById("color-mix");
const useCameraButton = document.getElementById("use-camera");
const clearInkButton = document.getElementById("clear-ink");
const fullscreenViewButton = document.getElementById("fullscreen-view");
const controlsDot = document.querySelector(".controls-dot");

// --- レンダーターゲット（バッファ）の設定 ---
// 浮動小数点テクスチャを使うことで色の精度を落とさず滑らかにする
const rtParams = {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType, // モバイル互換性のためHalfFloat推奨
};

// 1. 動き検出用
const rtMotion = new THREE.WebGLRenderTarget(
    window.innerWidth,
    window.innerHeight,
    rtParams,
);

// 2. インクシミュレーション用（Ping-Pong）
// AとBを交互に入れ替えて「前のフレーム」を参照できるようにする
let rtSimA = new THREE.WebGLRenderTarget(
    window.innerWidth,
    window.innerHeight,
    rtParams,
);
let rtSimB = new THREE.WebGLRenderTarget(
    window.innerWidth,
    window.innerHeight,
    rtParams,
);

// 3. 過去のビデオフレーム保存用
rtVideoPrev = new THREE.WebGLRenderTarget(1024, 1024, rtParams);

// --- マテリアル（シェーダー）の設定 ---

// 1. 動き検出
const motionMaterial = new THREE.ShaderMaterial({
    uniforms: {
        tCurrent: { value: null },
        tPrevious: { value: null },
        uSensitivity: { value: 6.0 }, // 感度調整
    },
    vertexShader: window.motionVertex,
    fragmentShader: window.motionFragment,
});

// 2. インクシミュレーション
const inkMaterial = new THREE.ShaderMaterial({
    uniforms: {
        tMotion: { value: null },
        tFeedback: { value: null }, // 前回の絵
        tCamera: { value: null }, // カメラ映像
        uTime: { value: 0.0 },
        uDeltaTime: { value: 1.0 / 60.0 },
        uInkTint: { value: new THREE.Color(0xff5a7a) },
        uTintMix: { value: 0.42 },
    },
    vertexShader: window.motionVertex,
    fragmentShader: window.simFragment,
});

// 3. 最終描画（コンポジット）
const compositeMaterial = new THREE.ShaderMaterial({
    uniforms: {
        tInk: { value: null },
        uResolution: {
            value: new THREE.Vector2(window.innerWidth, window.innerHeight),
        },
    },
    vertexShader: window.motionVertex,
    fragmentShader: window.compositeFragment,
});

// 4. コピー用（ビデオフレーム保存）
const copyMaterial = new THREE.MeshBasicMaterial({ map: null });

// メッシュ作成
const quad = new THREE.Mesh(geometry, motionMaterial);
scene.add(quad);

function setStatus(text, visible = true) {
    loadingEl.textContent = text;
    loadingEl.style.opacity = visible ? 1 : 0;
}

function stopCameraStream() {
    if (!cameraStream) {
        return;
    }

    cameraStream.getTracks().forEach((track) => {
        track.stop();
    });
    cameraStream = null;
}

function clearRenderTarget(target) {
    renderer.setRenderTarget(target);
    renderer.clear(true, true, true);
    renderer.setRenderTarget(null);
}

function clearInkBuffers() {
    clearRenderTarget(rtMotion);
    clearRenderTarget(rtSimA);
    clearRenderTarget(rtSimB);
    clearRenderTarget(rtVideoPrev);
}

function setVideoTexture() {
    if (videoTexture) {
        videoTexture.dispose();
    }

    videoTexture = new THREE.VideoTexture(video);
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;
    videoTexture.generateMipmaps = false;
    inkMaterial.uniforms.tCamera.value = videoTexture;
    motionMaterial.uniforms.tCurrent.value = videoTexture;
}

function updateInkTint() {
    const color = new THREE.Color(inkColorInput.value);
    const tintMix = Number(colorMixInput.value) / 100;

    inkMaterial.uniforms.uInkTint.value.copy(color);
    inkMaterial.uniforms.uTintMix.value = tintMix;
    controlsDot.style.background = inkColorInput.value;
    controlsDot.style.boxShadow = `0 0 0 5px ${inkColorInput.value}29`;
}

function setMenuOpen(isOpen) {
    const label = isOpen ? "設定を閉じる" : "設定を開く";

    document.body.classList.toggle("menu-open", isOpen);
    menuButton.setAttribute("aria-expanded", String(isOpen));
    menuButton.setAttribute("aria-label", label);
}

function enterImmersiveMode() {
    setMenuOpen(false);
    document.body.classList.add("immersive");

    if (document.fullscreenEnabled && !document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
    }
}

function exitImmersiveMode() {
    document.body.classList.remove("immersive");

    if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
    }
}

function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setStatus("Camera Unavailable");
        return;
    }

    isCameraReady = false;
    setStatus("Initialize Camera...");

    if (loadedVideoUrl) {
        URL.revokeObjectURL(loadedVideoUrl);
        loadedVideoUrl = null;
    }

    video.pause();
    video.removeAttribute("src");
    video.srcObject = null;
    video.onloadeddata = null;
    video.onerror = null;
    video.load();

    navigator.mediaDevices
        .getUserMedia({
            video: { facingMode: "user", width: 1280, height: 720 },
        })
        .then((stream) => {
            stopCameraStream();
            cameraStream = stream;
            video.srcObject = stream;
            return video.play();
        })
        .then(() => {
            setVideoTexture();
            clearInkBuffers();
            setStatus("", false);
            isCameraReady = true;
        })
        .catch((err) => {
            console.error(err);
            setStatus("Camera Blocked");
        });
}

function loadVideoFile(file) {
    if (!file) {
        return;
    }

    isCameraReady = false;
    setStatus("Loading Video...");
    stopCameraStream();

    if (loadedVideoUrl) {
        URL.revokeObjectURL(loadedVideoUrl);
    }
    loadedVideoUrl = URL.createObjectURL(file);

    video.pause();
    video.srcObject = null;
    video.onloadeddata = () => {
        video
            .play()
            .then(() => {
                setVideoTexture();
                clearInkBuffers();
                setStatus("", false);
                isCameraReady = true;
            })
            .catch((err) => {
                console.error(err);
                setStatus("Video Play Blocked");
            });
    };

    video.onerror = () => {
        setStatus("Video Load Failed");
    };
    video.src = loadedVideoUrl;
    video.currentTime = 0;
    video.load();
}

inkColorInput.addEventListener("input", updateInkTint);
colorMixInput.addEventListener("input", updateInkTint);
menuButton.addEventListener("click", () => {
    if (document.body.classList.contains("immersive")) {
        return;
    }

    setMenuOpen(!document.body.classList.contains("menu-open"));
});
videoFileInput.addEventListener("change", (event) => {
    loadVideoFile(event.target.files[0]);
});
useCameraButton.addEventListener("click", () => {
    videoFileInput.value = "";
    startCamera();
});
clearInkButton.addEventListener("click", clearInkBuffers);
fullscreenViewButton.addEventListener("click", enterImmersiveMode);
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        exitImmersiveMode();
    }
});
document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) {
        document.body.classList.remove("immersive");
    }
});
controlsPanel.addEventListener("click", (event) => {
    event.stopPropagation();
});
updateInkTint();
startCamera();

// --- アニメーションループ ---
function animate() {
    requestAnimationFrame(animate);

    if (!isCameraReady || !videoTexture) return;

    const deltaTime = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;

    // 1. 【動き検出】 現在のビデオ vs 1フレーム前のビデオ
    quad.material = motionMaterial;
    motionMaterial.uniforms.tPrevious.value = rtVideoPrev.texture; // 保存しておいた過去フレーム
    // tCurrentはvideoTextureが自動更新されているのでそのまま参照される
    renderer.setRenderTarget(rtMotion);
    renderer.render(scene, camera);

    // 2. 【インク拡散】 フィードバックループ
    quad.material = inkMaterial;
    inkMaterial.uniforms.tMotion.value = rtMotion.texture;
    inkMaterial.uniforms.tFeedback.value = rtSimA.texture; // 前回のインク状態
    inkMaterial.uniforms.uTime.value = time;
    inkMaterial.uniforms.uDeltaTime.value = deltaTime;

    renderer.setRenderTarget(rtSimB); // Bに書き込む
    renderer.render(scene, camera);

    // バッファの交換 (Ping-Pong)
    const temp = rtSimA;
    rtSimA = rtSimB;
    rtSimB = temp;

    // 3. 【画面への描画】 紙の質感と合成して表示
    quad.material = compositeMaterial;
    compositeMaterial.uniforms.tInk.value = rtSimA.texture;
    renderer.setRenderTarget(null); // 画面に出力
    renderer.render(scene, camera);

    // 4. 【次フレームの準備】 現在のビデオ画像を保存
    quad.material = copyMaterial;
    copyMaterial.map = videoTexture;
    renderer.setRenderTarget(rtVideoPrev);
    renderer.render(scene, camera);
}

// ウィンドウサイズ変更対応
window.addEventListener("resize", () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);

    // レンダーターゲットのリサイズ
    rtMotion.setSize(w, h);
    rtSimA.setSize(w, h);
    rtSimB.setSize(w, h);
    compositeMaterial.uniforms.uResolution.value.set(w, h);
});

animate();
