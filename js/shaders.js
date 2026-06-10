window.motionVertex = /* glsl */ `
    varying vec2 vUv;

    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

window.motionFragment = /* glsl */ `
    uniform sampler2D tCurrent;
    uniform sampler2D tPrevious;
    uniform float uSensitivity;
    varying vec2 vUv;

    void main() {
        vec3 curr = texture2D(tCurrent, vUv).rgb;
        vec3 prev = texture2D(tPrevious, vUv).rgb;

        // 輝度差だけでなく、色の距離で判定して精度を上げる
        float diff = distance(curr, prev);

        // ノイズ除去（閾値を設けて微細なノイズを無視）
        float motion = smoothstep(0.08, 0.25, diff);

        gl_FragColor = vec4(vec3(motion * uSensitivity), 1.0);
    }
`;

window.simFragment = /* glsl */ `
    uniform sampler2D tMotion;    // 動きマスク
    uniform sampler2D tFeedback;  // 1フレーム前の描画結果
    uniform sampler2D tCamera;    // 現在のカメラ映像
    uniform float uTime;
    uniform float uDeltaTime;
    uniform vec3 uInkTint;
    uniform float uTintMix;
    varying vec2 vUv;

    // ノイズ関数（流体のようなゆらぎを作る）
    vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }

    float snoise(vec2 v) {
        const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
        vec2 i  = floor(v + dot(v, C.yy) );
        vec2 x0 = v - i + dot(i, C.xx);
        vec2 i1;
        i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
        vec4 x12 = x0.xyxy + C.xxzz;
        x12.xy -= i1;
        i = mod289(i);
        vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 )) + i.x + vec3(0.0, i1.x, 1.0 ));
        vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
        m = m*m ;
        m = m*m ;
        vec3 x = 2.0 * fract(p * C.www) - 1.0;
        vec3 h = abs(x) - 0.5;
        vec3 ox = floor(x + 0.5);
        vec3 a0 = x - ox;
        m *= 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );
        vec3 g;
        g.x  = a0.x  * x0.x  + h.x  * x0.y;
        g.yz = a0.yz * x12.xz + h.yz * x12.yw;
        return 130.0 * dot(m, g);
    }

    vec3 palette(float t) {
        return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
    }

    void main() {
        float motionVal = texture2D(tMotion, vUv).r;
        float dt = clamp(uDeltaTime, 0.0, 0.05);

        // --- 座標のゆらぎ（インクの拡散） ---
        // ノイズを使ってUV座標を微妙にずらし、インクが滲む動きを作る
        float noiseScale = 6.0;
        float flowSpeed = 0.2;
        vec2 flowDir = vec2(
            snoise(vUv * noiseScale + uTime * flowSpeed),
            snoise(vUv * noiseScale + uTime * flowSpeed + 100.0)
        );

        // 拡散の強さ（値が小さいほど色がその場に留まる）
        vec2 offset = flowDir * 0.003;

        // 過去のフレームを取得（ずらした座標から）
        vec4 prevColor = texture2D(tFeedback, vUv + offset);

        // --- 新しい色の注入 ---
        // カメラの色を取得し、少し強調する（水彩っぽく鮮やかに）
        vec3 camColor = texture2D(tCamera, vUv).rgb;

        // 彩度と明度を補正し、暗い入力でも色が残るようにする
        float luminance = dot(camColor, vec3(0.299, 0.587, 0.114));
        vec3 saturatedColor = mix(vec3(luminance), camColor, 2.1);
        vec3 hueAssist = palette(fract(vUv.x * 0.42 + vUv.y * 0.37 + uTime * 0.035));
        float darkBoost = 1.0 - smoothstep(0.08, 0.55, luminance);
        saturatedColor = mix(saturatedColor, hueAssist, darkBoost * 0.45);
        saturatedColor = clamp(saturatedColor * 1.18 + hueAssist * 0.08, 0.0, 1.0);
        saturatedColor = mix(saturatedColor, saturatedColor * uInkTint + uInkTint * 0.35, uTintMix);

        // 動きがあった部分だけ新しい色を混ぜる
        // mix(A, B, factor): AとBをfactorの割合で混ぜる
        // motionValが高いほど新しい色が強く出る
        float blendRate = 8.0;
        float blendAmount = 1.0 - exp(-motionVal * blendRate * dt);
        vec3 finalColor = mix(prevColor.rgb, saturatedColor, blendAmount);

        // --- 色の減衰（乾燥） ---
        // フレームレート差で乾き方が変わらないよう秒単位の係数にする
        finalColor *= exp(-0.06 * dt);

        gl_FragColor = vec4(finalColor, 1.0);
    }
`;

window.compositeFragment = /* glsl */ `
    uniform sampler2D tInk;
    uniform vec2 uResolution;
    varying vec2 vUv;

    // 乱数生成
    float random(vec2 st) {
        return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453);
    }

    void main() {
        vec4 ink = texture2D(tInk, vUv);

        // --- 画用紙の生成 ---
        // ベースの紙色（温かみのある白）
        vec3 paperBase = vec3(0.96, 0.95, 0.93);

        // 紙の繊維ノイズ
        float grain = random(vUv * 3.0);
        float fineGrain = random(vUv * 200.0); // 細かいザラつき

        vec3 paper = paperBase - (grain * 0.02) - (fineGrain * 0.03);

        // --- インクの合成 ---
        // インクの明るさを反転させて濃度とする（乗算合成的アプローチ）
        // インク色が黒(0,0,0)に近いほど濃く塗るのではなく、
        // 今回はインク色が明るい(鮮やか)なので、そのまま色として乗せる

        // インクの強さ（透明度）を色の明るさから算出
        float inkAlpha = length(ink.rgb);
        inkAlpha = smoothstep(0.0, 1.2, inkAlpha); // 調整

        // 紙の上にインクを乗せる（水彩風ブレンド）
        // インクがある場所はインク色、ない場所は紙の色
        vec3 final = mix(paper, ink.rgb, inkAlpha * 0.9);

        // ビネット効果（四隅を少し暗くして雰囲気出し）
        float dist = distance(vUv, vec2(0.5));
        final *= smoothstep(0.8, 0.3, dist * 0.6);

        gl_FragColor = vec4(final, 1.0);
    }
`;
