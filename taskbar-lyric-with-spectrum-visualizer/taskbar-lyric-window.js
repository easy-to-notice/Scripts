/**
 * 任务栏歌词 + 频谱可视化 - 浮窗入口
 * 在任务栏上方显示当前歌词和专辑封面的透明浮窗，并在底部绘制实时音频频谱。
 * 自动检测任务栏位置并贴靠,无需手动设置坐标。
 *
 * 共享常量和工具定义在 ./shared.js 中。
 * 由于浮窗运行在独立上下文中,本文件内联了一份最小副本。
 */

// ==================== 内联常量(与 shared.js 保持一致) ====================

/** BroadcastChannel 频道名称,用于接收主插件的设置同步 */
const CHANNEL_NAME = "echo-plugin:taskbar-lyric-spectrum:settings";

/** 歌词刷新间隔(毫秒), 33ms ≈30fps */
const LYRIC_CLOCK_INTERVAL_MS = 33;

/** 歌词前瞻时间(毫秒),提前 150ms 切换歌词 */
const LYRIC_LOOKAHEAD_MS = 150;

/** 默认任务栏高度(后备值) */
const TASKBAR_FALLBACK_HEIGHT = 48;

/** 主题色同步数据存储键（主入口 index.js 解析主窗口 CSS 主题变量写入，浮窗轮询读取） */
const SPECTRUM_PALETTE_SYNC_KEY = "spectrumPaletteSync";

/** 主题色同步数据轮询间隔(毫秒) */
const SPECTRUM_PALETTE_SYNC_INTERVAL_MS = 50; // 主题色 storage 轮询（主入口变更写入，双端 50ms）

/** 频谱渲染帧率上限（雾状模式最高 24，混合最高 30） */
const SPECTRUM_RENDER_FPS = 30;

/** 官方 spectrum-visualizer 的调色板（theme 由主窗口解析 CSS 变量） */
const PALETTES = {
  theme: ["#0071e3", "#5ac8fa", "#7c6cff"],
  aurora: ["#42f5b3", "#35b7ff", "#a86dff"],
  ember: ["#ffe08a", "#ff8f4a", "#ff4d7d"],
  ice: ["#e9fbff", "#8ee7ff", "#6d8dff"],
  mono: ["#f7fbff", "#b8c4d6", "#6b7280"],
};

/** 最近一次解析到的主题三色（"跟随主程序"调色板使用，浮窗轮询 storage 更新） */
let themePaletteColors = null;

/** 默认设置(与 shared.js DEFAULT_SETTINGS 同步) */
const DEFAULT_SETTINGS = {
  enabled: true,
  doubleLine: true,
  showCover: true,
  coverSize: 36,
  coverShape: "square",
  coverPosition: "left",
  lyricFontSize: 14,
  secondaryFontSize: 12,
  fontFamily: "",
  playedColor: "#31cfa1",
  unplayedColor: "#7a7a7a",
  windowWidth: 600,
  windowHeight: 40,
taskbarOffsetX: -100,
  taskbarOffsetY: 0,
  lockPosition: true,
  showLockButton: false,
  manualAdjust: true,
  clickToShowMain: true,
  showTranslation: true,
  showRomanization: false,
  secondaryScroll: false,
  lyricFilterEnabled: false,
  lyricFilterPatterns: "作词|作曲|编曲|制作人|混音|母带|录音|和声|监制|出品|发行|版权|OP|SP|企划|统筹|词：|曲：",
  emptyText: "EchoMusic",
  hotkey: "Ctrl+Alt+I",
  showBackdrop: true,
  spectrumFps: 30,
  spectrumMode: "hybrid",
  spectrumPalette: "theme",
  spectrumFill: 84,
  spectrumOpacity: 56,
  mistIntensity: 78,
  mistSoftness: 72,
  mistMotion: 42,
  centeredBarWidth: 2,
};

// ==================== 工具函数 ====================

/** 数值钳制 */
const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, Number(value) || 0));

/** 追加圆角矩形路径 */
const appendRoundRect = (context, x, y, width, height, radius) => {
  const r = Math.min(radius, width / 2, height / 2);
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
};

// ==================== 频谱绘制 ====================

/** 解析当前调色板三色（theme 用主窗口采样的主题色，其余用内置 PALETTES） */
const getPaletteColors = (settings) => {
  if (settings?.spectrumPalette === "theme") {
    if (themePaletteColors && themePaletteColors.length === 3) return themePaletteColors;
    return PALETTES.theme;
  }
  return PALETTES[settings?.spectrumPalette] || PALETTES.theme;
};

/** 生成渐变（使用当前调色板） */
const makeSpectrumGradient = (context, width, height, colors) => {
  const gradient = context.createLinearGradient(0, height, width, 0);
  gradient.addColorStop(0, colors[0]);
  gradient.addColorStop(0.52, colors[1]);
  gradient.addColorStop(1, colors[2]);
  return gradient;
};

/** 绘制背景光晕（与 spectrum-visualizer 的 drawBackdrop 一致：整画布渐变，少量能量响应） */
const drawSpectrumBackdrop = (context, width, height, frame, colors) => {
  const energy = clamp(frame?.rms ?? 0, 0, 1);
  context.save();
  context.globalAlpha = 0.18 + energy * 0.14;
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, colors[0]);
  gradient.addColorStop(0.5, "rgba(10, 15, 28, 0.12)");
  gradient.addColorStop(1, colors[2]);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  context.restore();
};

/** 绘制柱状频谱（底部锚定） */
const drawSpectrumBars = (context, width, height, frame, fill, colors) => {
  const bins = frame?.bins || [];
  const count = Math.max(1, bins.length);
  const bottom = height - 1;
  const top = Math.max(4, height - height * (fill / 100));
  const slot = width / count;
  const gap = Math.max(1, Math.min(3, slot * 0.22));
  const radius = Math.min(3, Math.max(1.5, slot * 0.22));
  const gradient = makeSpectrumGradient(context, width, height, colors);

  context.save();
  context.shadowColor = "rgba(80, 220, 255, 0.14)";
  context.shadowBlur = 8;
  context.fillStyle = gradient;
  context.beginPath();
  for (let index = 0; index < count; index += 1) {
    const value = Math.pow(clamp(bins[index] || 0, 0, 1), 1.35);
    const barHeight = Math.max(1.5, value * (bottom - top));
    const x = index * slot + gap * 0.5;
    const y = bottom - barHeight;
    const barWidth = Math.max(1.5, slot - gap);
    appendRoundRect(context, x, y, barWidth, barHeight, radius);
  }
  context.fill();
  context.restore();
};

/**
 * 获取波形数据。
 * 优先使用共享分析器帧自带的 waveform；快照帧未提供时用 bins 线性插值合成，
 * 保证 wave/hybrid 模式在任何数据源下都能绘制。
 * @param {Object} frame - 频谱快照帧
 * @returns {number[]} 归一化波形采样（-1..1，常用 256 点）
 */
const getSpectrumWaveform = (frame) => {
  const waveform = frame?.waveform;
  if (Array.isArray(waveform) && waveform.length > 1) return waveform;
  const bins = frame?.bins || [];
  if (bins.length < 2) return [];
  const count = 256;
  const output = [];
  for (let index = 0; index < count; index += 1) {
    const position = (index / (count - 1)) * (bins.length - 1);
    const lower = Math.floor(position);
    const upper = Math.min(bins.length - 1, lower + 1);
    const fraction = position - lower;
    const value = bins[lower] + (bins[upper] - bins[lower]) * fraction;
    output.push(value * 2 - 1);
  }
  return output;
};

/** 绘制波形线（与 spectrum-visualizer 的 drawWave 一致：中心线 + 渐变描边 + 光晕） */
const drawSpectrumWave = (context, width, height, frame, fill, colors) => {
  const waveform = getSpectrumWaveform(frame);
  if (waveform.length < 2) return;
  const center = height * 0.5;
  const amplitude = height * 0.25 * (fill / 100);

  context.save();
  context.globalAlpha = 0.38;
  context.lineWidth = 2;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.shadowColor = colors[1];
  context.shadowBlur = 16;
  context.strokeStyle = makeSpectrumGradient(context, width, height, colors);
  context.beginPath();
  waveform.forEach((sample, index) => {
    const x = (index / Math.max(1, waveform.length - 1)) * width;
    const y = center + clamp(sample, -1, 1) * amplitude;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.stroke();
  context.restore();
};

/** 混合样式：先波形线后柱状（与 spectrum-visualizer 的 hybrid 一致） */
const drawSpectrumHybrid = (context, width, height, frame, fill, colors) => {
  drawSpectrumWave(context, width, height, frame, fill, colors);
  drawSpectrumBars(context, width, height, frame, fill, colors);
};

// ==================== 雾状频谱 ====================

/** 从频段数据构建雾状轮廓（与 spectrum-visualizer 的 buildMistProfile 一致） */
const buildMistProfile = (bins, pointCount = 28) => {
  const count = Math.round(clamp(pointCount, 8, 64));
  const source = Array.from(bins || [], (value) => clamp(value, 0, 1));
  if (!source.length) return Array.from({ length: count }, () => 0);

  const profile = Array.from({ length: count }, (_, index) => {
    const center = (index / Math.max(1, count - 1)) * (source.length - 1);
    const radius = Math.max(1, (source.length / count) * 1.8);
    const from = Math.max(0, Math.floor(center - radius));
    const to = Math.min(source.length - 1, Math.ceil(center + radius));
    let weighted = 0;
    let weightTotal = 0;

    for (let sourceIndex = from; sourceIndex <= to; sourceIndex += 1) {
      const distance = Math.abs(sourceIndex - center) / radius;
      const weight = Math.max(0, 1 - distance * 0.72);
      weighted += source[sourceIndex] * weight;
      weightTotal += weight;
    }

    return Math.pow(weighted / Math.max(weightTotal, 1), 0.78);
  });

  return profile.map((value, index) => {
    const previous = profile[Math.max(0, index - 1)];
    const next = profile[Math.min(profile.length - 1, index + 1)];
    return clamp(previous * 0.2 + value * 0.6 + next * 0.2, 0, 1);
  });
};

/** 追加雾状路径（与 spectrum-visualizer 的 appendMistPath 一致） */
const appendMistPath = (
  context,
  profile,
  width,
  baseline,
  fillHeight,
  layer,
  phase,
  motion,
  idle,
) => {
  const padding = Math.max(18, width * 0.035);
  const span = width + padding * 2;
  const points = profile.map((value, index) => {
    const progress = index / Math.max(1, profile.length - 1);
    const x = -padding + progress * span;
    const drift =
      Math.sin(
        progress * Math.PI * (2.4 + layer.index * 0.35) + phase + layer.phase,
      ) *
      (0.018 + motion * 0.035);
    const ambient = idle ? 0.075 : 0.025;
    const level = ambient + value * layer.scale + drift;
    return { x, y: baseline - fillHeight * clamp(level, 0.02, 1) };
  });

  context.beginPath();
  context.moveTo(-padding, baseline + padding);
  context.lineTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    const midpointX = (previous.x + point.x) * 0.5;
    const midpointY = (previous.y + point.y) * 0.5;
    context.quadraticCurveTo(previous.x, previous.y, midpointX, midpointY);
  }
  const last = points[points.length - 1];
  context.quadraticCurveTo(last.x, last.y, width + padding, last.y);
  context.lineTo(width + padding, baseline + padding);
  context.closePath();
};

/** 计算雾状渲染分层参数（与 spectrum-visualizer 的 getMistRenderLayers 一致） */
const getMistRenderLayers = (settings, energy = 0) => {
  const intensity = clamp(settings.mistIntensity ?? 78, 35, 100) / 100;
  const softness = clamp(settings.mistSoftness ?? 72, 20, 100) / 100;
  const signal = clamp(energy, 0, 1);
  return [
    { index: 0, scale: 0.58, alpha: 0.48, phase: 0.3, blur: 1.05 },
    { index: 1, scale: 0.78, alpha: 0.36, phase: 2.2, blur: 0.72 },
    { index: 2, scale: 0.98, alpha: 0.28, phase: 4.4, blur: 0.42 },
  ].map((layer) => ({
    ...layer,
    alpha: (layer.alpha + signal * 0.12) * intensity,
    blur: Math.round((3 + softness * 11) * layer.blur),
  }));
};

/** 绘制雾状频谱（锚定底部，与 spectrum-visualizer 的 drawMist 一致） */
const drawSpectrumMist = (context, width, height, frame, settings, time, idle, colors) => {
  const pointCount = Math.round(clamp(width / 18, 18, 44));
  const profile = buildMistProfile(idle ? [] : frame?.bins, pointCount);
  const energy = clamp(frame?.rms ?? 0, 0, 1);
  const fillHeight = height * ((settings.spectrumFill ?? 84) / 100);
  const baseline = height + 2;
  const reduceMotion = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  )?.matches;
  const motion = reduceMotion ? 0 : (settings.mistMotion ?? 42) / 100;
  const phase = (time / 1000) * motion * 0.9;
  const layers = getMistRenderLayers(settings, energy);

  context.save();
  context.globalCompositeOperation = "screen";
  for (const layer of layers) {
    const gradient = context.createLinearGradient(0, baseline, width, 0);
    gradient.addColorStop(0, colors[layer.index % colors.length]);
    gradient.addColorStop(0.5, colors[(layer.index + 1) % colors.length]);
    gradient.addColorStop(1, colors[(layer.index + 2) % colors.length]);
    context.save();
    context.globalAlpha = layer.alpha;
    context.filter = `blur(${layer.blur}px)`;
    context.fillStyle = gradient;
    appendMistPath(
      context,
      profile,
      width,
      baseline,
      fillHeight,
      layer,
      phase,
      motion,
      idle,
    );
    context.fill();
    context.restore();
  }
  context.restore();
};

// ==================== 中心频谱 ====================

/** 构建中心镜像轮廓（与 spectrum-visualizer 的 buildCenteredProfile 一致） */
const buildCenteredProfile = (bins, barCount) => {
  const count = Math.round(clamp(barCount, 2, 512));
  const source = Array.from(bins || [], (value) => clamp(value, 0, 1));
  if (!source.length) return Array.from({ length: count }, () => 0);

  const sampleAt = (position) => {
    const bounded = clamp(position, 0, source.length - 1);
    const lower = Math.floor(bounded);
    const upper = Math.min(source.length - 1, lower + 1);
    const fraction = bounded - lower;
    return source[lower] + (source[upper] - source[lower]) * fraction;
  };

  return Array.from({ length: count }, (_, index) => {
    const progress = index / Math.max(1, count - 1);
    const frequencyPosition = Math.abs(progress * 2 - 1) * (source.length - 1);
    return clamp(
      (sampleAt(frequencyPosition - 0.65) +
        sampleAt(frequencyPosition) * 2 +
        sampleAt(frequencyPosition + 0.65)) /
        4,
      0,
      1,
    );
  });
};

/** 计算中心频谱条布局（与 spectrum-visualizer 的 getCenteredBarLayout 一致） */
const getCenteredBarLayout = (width, requestedBarWidth = 2, gap = 3) => {
  const barWidth = clamp(requestedBarWidth, 1, 8);
  const safeGap = clamp(gap, 1, 8);
  const count = Math.min(
    512,
    Math.max(2, Math.floor(Math.max(0, width) / (barWidth + safeGap))),
  );
  const slotWidth = Math.max(0, width) / count;
  return {
    count,
    slotWidth,
    barWidth: Math.min(barWidth, Math.max(1, slotWidth - 1)),
  };
};

/** 平滑更新中心频谱显示值（与 spectrum-visualizer 的 updateCenteredDisplay 一致） */
const updateCenteredDisplay = (previous, target, attack = 0.4, decay = 0.88) =>
  target.map((value, index) => {
    const current = clamp(previous?.[index] ?? 0, 0, 1);
    return value > current
      ? current + (value - current) * attack
      : current * decay + value * (1 - decay);
  });

/** 绘制中心镜像频谱（与 spectrum-visualizer 的 drawCentered 一致，全局显示值状态） */
const drawSpectrumCentered = (context, width, height, frame, settings, display, colors) => {
  const { count, slotWidth, barWidth } = getCenteredBarLayout(
    width,
    settings.centeredBarWidth ?? 2,
  );
  const target = buildCenteredProfile(frame?.bins, count);
  const nextDisplay = updateCenteredDisplay(display, target);
  display.length = 0;
  display.push(...nextDisplay);

  const bottom = height - 2;
  const fillHeight = height * ((settings.spectrumFill ?? 84) / 100);

  context.save();
  context.globalAlpha = 0.65;
  context.fillStyle = colors[0];
  context.beginPath();
  for (let index = 0; index < count; index += 1) {
    const barHeight = nextDisplay[index] * fillHeight;
    if (barHeight <= 0.5) continue;
    const x = index * slotWidth + (slotWidth - barWidth) * 0.5;
    appendRoundRect(
      context,
      x,
      bottom - barHeight,
      barWidth,
      barHeight,
      2,
    );
  }
  context.fill();
  context.restore();
  return nextDisplay;
};

/** 绘制待机波形（无真实音频数据时，细微上下波动） */
const drawSpectrumIdle = (context, width, height, settings, time, colors) => {
  const count = 48;
  const slot = width / count;
  context.save();
  context.globalAlpha = 0.2;
  context.fillStyle = colors[1];
  context.beginPath();
  for (let index = 0; index < count; index += 1) {
    const wave = 0.5 + 0.5 * Math.sin(time / 700 + index * 0.36);
    const barHeight = 2 + wave * 7;
    const x = index * slot + slot * 0.22;
    appendRoundRect(
      context,
      x,
      height - 10 - barHeight,
      slot * 0.56,
      barHeight,
      2,
    );
  }
  context.fill();
  context.restore();
};

// ==================== 任务栏定位 ====================

/**
 * 检测任务栏信息
 * 使用 window.screen API 推断任务栏位置和尺寸。
 * @returns {{ position: string, size: number, screenWidth: number, screenHeight: number }}
 */
const detectTaskbarInfo = () => {
  const s = window.screen || {};
  const width = s.width || 1920;
  const height = s.height || 1080;
  const availLeft = s.availLeft || 0;
  const availTop = s.availTop || 0;
  const availWidth = s.availWidth || width;
  const availHeight = s.availHeight || height;

  let position = "bottom";
  let size = height - availHeight;

  if (availTop > 0) {
    position = "top";
    size = availTop;
  } else if (availLeft > 0) {
    position = "left";
    size = availLeft;
  } else if (availWidth < width) {
    position = "right";
    size = width - availWidth;
  }

  // 后备:如果计算出的 taskbar 高度为 0 或异常大,使用默认值
  if (size <= 0 || size > 200) {
    size = TASKBAR_FALLBACK_HEIGHT;
    position = "bottom";
  }

  return { position, size, screenWidth: width, screenHeight: height };
};

/**
 * 根据任务栏检测结果和用户设置,计算窗口应放置的位置和尺寸。
 * 窗口贴靠到任务栏上方边缘(占据任务栏区域顶部)。
 * @param {Object} settings - 用户设置
 * @returns {{ x: number, y: number, width: number, height: number, taskbar: Object }}
 */
const computeWindowBounds = (settings) => {
  const taskbar = detectTaskbarInfo();
  const width = settings.windowWidth;
  // 窗口高度不能超过任务栏高度,否则会溢出到工作区
  const height = Math.min(settings.windowHeight, taskbar.size);

  let x = 0;
  let y = 0;

  switch (taskbar.position) {
    case "bottom":
      // 贴靠在屏幕底部任务栏上方边缘
      y = taskbar.screenHeight - taskbar.size;
      x = Math.max(0, Math.round((taskbar.screenWidth - width) / 2));
      break;
    case "top":
      y = taskbar.size;
      x = Math.max(0, Math.round((taskbar.screenWidth - width) / 2));
      break;
    case "left":
      x = taskbar.size;
      y = Math.max(0, Math.round((taskbar.screenHeight - height) / 2));
      break;
    case "right":
      x = taskbar.screenWidth - taskbar.size - width;
      y = Math.max(0, Math.round((taskbar.screenHeight - height) / 2));
      break;
    default:
      x = Math.round((taskbar.screenWidth - width) / 2);
      y = taskbar.screenHeight - taskbar.size;
  }

  // 百分比偏移 → 像素值(有偏移就应用,不依赖手动调整开关)
  const pctX = clamp(settings.taskbarOffsetX ?? 0, -100, 100);
  const pctY = clamp(settings.taskbarOffsetY ?? 0, -100, 100);
  const ox = Math.round((pctX / 100) * (taskbar.screenWidth - width) / 2);
  const oy = Math.round((pctY / 100) * Math.max(taskbar.screenHeight / 4, taskbar.size * 3));

  // 正百分比 = 远离任务栏边缘,即向屏幕内侧移动
  switch (taskbar.position) {
    case "bottom":
      y -= oy;  // 正 = 向上
      x += ox;  // 正 = 向右
      break;
    case "top":
      y += oy;  // 正 = 向下
      x += ox;
      break;
    case "left":
      x += ox;  // 正 = 向右
      y += oy;
      break;
    case "right":
      x -= ox;  // 正 = 向左
      y += oy;
      break;
    default:
      y -= oy;
      x += ox;
  }

  return { x, y, width, height, taskbar };
};

/**
 * 定位窗口到任务栏上方
 * @param {Object} ctx - 插件上下文
 * @param {Object} settings - 用户设置
 */
const positionToTaskbar = (ctx, settings) => {
  // 解锁状态下不强制定位,由用户拖拽自由控制窗口位置
  if (!settings.lockPosition) return;
  try {
    const bounds = computeWindowBounds(settings);
    ctx.window.move({
      x: bounds.x,
      y: bounds.y,
    });
  } catch (error) {
    console.warn("[taskbar-lyric-spectrum] 窗口定位失败", error);
  }
};

// ==================== 歌词处理 ====================

/**
 * 根据播放状态推算当前播放时间(毫秒)
 */
const getEstimatedPlaybackMs = (playback) => {
  if (!playback) return 0;
  const baseMs = Math.max(0, Number(playback.currentTime || 0) * 1000);
  if (!playback.isPlaying) return baseMs;
  const updatedAt = Number(playback.updatedAt || Date.now());
  const playbackRate = Math.max(0.1, Number(playback.playbackRate || 1));
  const elapsedMs = Math.max(0, Date.now() - updatedAt) * playbackRate;
  const durationMs = Math.max(0, Number(playback.duration || 0) * 1000);
  const seekMs = baseMs + elapsedMs;
  return durationMs > 0 ? Math.min(seekMs, durationMs) : seekMs;
};

const getLyricSeekMs = (snapshot) =>
  getEstimatedPlaybackMs(snapshot.playback) +
  Number(snapshot.lyric?.timeOffset || 0);

const getLineStartMs = (line) => {
  const charStart = line?.characters?.[0]?.startTime;
  if (Number.isFinite(charStart)) return charStart;
  return Math.round((Number(line?.time) || 0) * 1000);
};

/** 计算当前行播放进度(0–1),用于驱动滚动位置 */
const getLineProgress = (line, lineIndex, allLines, seekMs) => {
  if (!line || !allLines?.length) return 0;
  const lineStart = getLineStartMs(line);
  const chars = line.characters || [];
  let lineEnd;
  if (chars.length > 0) {
    lineEnd = chars[chars.length - 1]?.endTime ?? 0;
  }
  if (!lineEnd || lineEnd <= lineStart) {
    const nextIdx = lineIndex + 1;
    lineEnd = nextIdx < allLines.length ? getLineStartMs(allLines[nextIdx]) : lineStart + 5000;
  }
  const duration = Math.max(lineEnd - lineStart, 1);
  return Math.max(0, Math.min(1, (seekMs - lineStart) / duration));
};

const calculateLineIndex = (lines, seekMs) => {
  if (!Array.isArray(lines) || lines.length === 0) return -1;
  let index = -1;
  let low = 0;
  let high = lines.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (seekMs >= getLineStartMs(lines[mid])) {
      index = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return index;
};

/** 从指定索引起查找第一个未被过滤的可见行索引 */
let _filterRegexCache = null;
let _filterRegexSource = null;

const findNextVisibleIndex = (fromIndex, lines, settings) => {
  if (!settings.lyricFilterEnabled || !settings.lyricFilterPatterns?.trim()) return fromIndex;
  if (fromIndex < 0 || !lines || fromIndex >= lines.length) return fromIndex;
  try {
    const pattern = settings.lyricFilterPatterns;
    if (_filterRegexSource !== pattern) {
      _filterRegexSource = pattern;
      _filterRegexCache = new RegExp(pattern, 'i');
    }
    const regex = _filterRegexCache;
    let i = fromIndex;
    while (i < lines.length) {
      const text = String(lines[i]?.text || "").trim();
      if (!regex.test(text)) return i;
      i++;
    }
    return lines.length - 1;
  } catch {
    return fromIndex;
  }
};

/**
 * 获取副文本内容
 */
const getSecondaryText = (lyric, line, nextLine, settings) => {
  if (!line) return null;

  const translated = String(line.translated || "").trim();
  if (settings.showTranslation && lyric?.wantTranslation && lyric?.hasTranslation && translated) {
    return { text: translated, type: "translation" };
  }

  const romanized = String(line.romanized || "").trim();
  if (settings.showRomanization && lyric?.wantRomanization && lyric?.hasRomanization && romanized) {
    return { text: romanized, type: "romanization" };
  }

  if (settings.doubleLine && nextLine) {
    return { text: String(nextLine.text || "").trim(), type: "nextLine" };
  }

  return null;
};

const isYrcLine = (line) => (line?.characters?.length ?? 0) > 1;

// ==================== 应用入口 ====================

/**
 * 激活浮窗窗口
 * @param {Object} ctx - EchoMusic 窗口上下文
 */
export function activateWindow(ctx) {
  const { h, createApp, ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } = ctx.vue;

  const App = {
    setup() {
      // 设置状态(响应式)
      const settings = reactive({ ...DEFAULT_SETTINGS });

      // 歌词状态
      const snapshot = ref(null);
      const currentIndex = ref(-1);
      let snapshotDispose = null;
      let clockTimer = null;
      let channel = null;
      let receivedFromChannel = false; // 防止竞态:标记是否已从 channel 收到设置
      let settingsSyncTimer = null;    // storage 轮询定时器(BroadcastChannel 后备)
      let lastSettingsHash = "";       // 上次轮询到的设置 hash,避免重复更新
      let paletteSyncTimer = null;     // 主题色轮询定时器(读取主入口解析的主窗口主题色)

      // ============ 频谱状态 ============
      let latestSpectrumFrame = null;  // 最近一次可用的频谱帧（独立 getSnapshot 轮询获取）
      let spectrumCanvas = null;       // canvas DOM 引用
      let spectrumCtx = null;          // canvas 2d context
      let spectrumRaf = 0;             // requestAnimationFrame id
      let spectrumLastDraw = 0;        // 上次绘制时间戳
      let spectrumRenderFps = SPECTRUM_RENDER_FPS; // 频谱渲染帧率（根据模式上限）
      let spectrumCenteredDisplay = []; // 中心频谱平滑显示值（跨帧保留）
      let snapshotPolling = false;     // getSnapshot 轮询防重入（异步 IPC 未返回时跳过下一拍）
      let snapshotLastAt = 0;          // 上次快照轮询时间戳
      let snapshotLogged = false;      // 诊断：是否已打印首帧信息

      // ============ 逐字高亮 DOM 驱动 ============
      let currentActiveLineIndex = -1;
      let currentActiveCharEls = [];   // 逐字歌词字符元素数组
      let currentActiveWholeSpan = null; // 非逐字歌词整体 span

      const resetCharEls = () => {
        currentActiveCharEls = [];
        currentActiveWholeSpan = null;
      };

      // 更新逐字 / 整句进度的核心函数
      const updateKaraokeProgress = (seekMs) => {
        const line = currentLine.value;
        if (!line) return;
        if (isYrcLine(line)) {
          const chars = line.characters;
          for (let i = 0; i < currentActiveCharEls.length; i++) {
            const el = currentActiveCharEls[i];
            if (!el) continue;
            const char = chars[i];
            if (!char) continue;
            const duration = Math.max((char.endTime || 0) - (char.startTime || 0), 0.001);
            const progress = Math.max(Math.min((seekMs - (char.startTime || 0)) / duration, 1), 0);
            el.style.backgroundPositionX = `${100 - progress * 100}%`;
          }
        } else {
          if (currentActiveWholeSpan) {
            const lineStart = getLineStartMs(line);
            const chars = line.characters || [];
            let lineEnd;
            if (chars.length > 0) {
              lineEnd = chars[chars.length - 1]?.endTime ?? 0;
            } else {
              const nextIdx = currentIndex.value + 1;
              const lines = snapshot.value?.lyric?.lines ?? [];
              lineEnd = nextIdx < lines.length ? getLineStartMs(lines[nextIdx]) : lineStart + 5000;
            }
            const duration = Math.max(lineEnd - lineStart, 1);
            const progress = Math.max(0, Math.min(1, (seekMs - lineStart) / duration));
            currentActiveWholeSpan.style.backgroundPositionX = `${100 - progress * 100}%`;
          }
        }
      };

      /**
       * 设置 BroadcastChannel 监听
       * 接收来自主插件(index.js)的设置同步。频谱不再经此转发：
       * 浮窗自行轮询 getSnapshot()（独立频谱查询）。主题色同样不走 channel，
       * 统一由 storage 快速轮询同步。
       */
      const setupChannel = () => {
        if (typeof BroadcastChannel !== "function") return;
        channel = new BroadcastChannel(CHANNEL_NAME);
        channel.onmessage = (event) => {
          const payload = event.data;
          if (!payload) return;
          if (payload.type !== "settings") return;
          receivedFromChannel = true;
          Object.assign(settings, payload.settings);
          // BroadcastChannel 可用，停止 storage 轮询空转
          if (settingsSyncTimer) { clearInterval(settingsSyncTimer); settingsSyncTimer = null; }
        };
      };

      /**
       * 从本插件存储读取主入口( index.js )解析的 EchoMusic 主窗口主题三色，
       * 仅供"跟随主程序"调色板使用。非 theme 调色板时跳过，减少无谓 IPC。
       */
      const applyPaletteSync = async () => {
        if (settings?.spectrumPalette !== "theme") return;
        try {
          const data = await ctx.storage.get(SPECTRUM_PALETTE_SYNC_KEY);
          if (!data || typeof data !== "object") return;
          if (
            Array.isArray(data.colors) &&
            data.colors.length === 3 &&
            data.colors.every((c) => typeof c === "string" && c.length > 0)
          ) {
            themePaletteColors = data.colors;
          }
        } catch { /* 静默忽略 */ }
      };

      /**
       * 刷新歌词进度
       */
      const tickLyric = () => {
        if (!settings.enabled) return;
        const snap = snapshot.value;
        if (!snap) return;
        const lines = snap.lyric?.lines ?? [];
        const progressSeekMs = getLyricSeekMs(snap);               // 不带超前，用于进度
        const indexSeekMs = progressSeekMs + LYRIC_LOOKAHEAD_MS;   // 带超前，用于切换行
        const idx = calculateLineIndex(lines, indexSeekMs);
        const rawIndex = idx >= 0 ? idx : (snap.lyric?.currentIndex ?? -1);
        currentIndex.value = findNextVisibleIndex(rawIndex, lines, settings);
        updateKaraokeProgress(progressSeekMs);
        updateScrollPosition();
      };

      // 当前歌词行
      const currentLine = computed(() => {
        const lines = snapshot.value?.lyric?.lines ?? [];
        return lines[currentIndex.value] ?? null;
      });

      // 下一行歌词(用于双行模式副文本)
      const nextLine = computed(() => {
        const lines = snapshot.value?.lyric?.lines ?? [];
        const startIdx = currentIndex.value + 1;
        if (startIdx >= lines.length) return null;
        const visibleIdx = findNextVisibleIndex(startIdx, lines, settings);
        return lines[visibleIdx] ?? null;
      });

      // 主歌词文本
      const currentText = computed(() => {
        if (!currentLine.value) return settings.emptyText || "";
        return String(currentLine.value.text || "").trim();
      });

      // 副歌词信息
      const secondaryInfo = computed(() =>
        getSecondaryText(snapshot.value?.lyric, currentLine.value, nextLine.value, settings),
      );

      const secondaryText = computed(() => secondaryInfo.value?.text || "");

      // ==================== 歌词滚动溢出检测 ====================

      const primaryOverflow = ref(false);
      const secondaryOverflow = ref(false);
      const primaryOverflowPx = ref(0);
      const secondaryOverflowPx = ref(0);
      let primaryScrollEl = null;
      let secondaryScrollEl = null;

      const checkOverflow = () => {
        if (primaryScrollEl) {
          const container = primaryScrollEl.parentElement;
          const overflow = primaryScrollEl.scrollWidth > container.clientWidth + 1;
          primaryOverflow.value = overflow;
          if (overflow) {
            primaryOverflowPx.value = primaryScrollEl.scrollWidth - container.clientWidth;
          }
        }
        if (secondaryScrollEl) {
          const container = secondaryScrollEl.parentElement;
          const overflow = secondaryScrollEl.scrollWidth > container.clientWidth + 1;
          secondaryOverflow.value = overflow;
          if (overflow) {
            secondaryOverflowPx.value = secondaryScrollEl.scrollWidth - container.clientWidth;
          }
        }
        updateScrollPosition();
      };

      /** 按播放进度驱动歌词滚动位置 */
      const updateScrollPosition = () => {
        const snap = snapshot.value;
        if (!snap) return;
        const allLines = snap.lyric?.lines ?? [];
        const seekMs = getLyricSeekMs(snap);

        if (primaryScrollEl) {
          if (primaryOverflow.value && primaryOverflowPx.value > 0) {
            const progress = getLineProgress(currentLine.value, currentIndex.value, allLines, seekMs);
            primaryScrollEl.style.transform = `translateX(${-primaryOverflowPx.value * progress}px)`;
          } else {
            primaryScrollEl.style.transform = '';
          }
        }

        if (secondaryScrollEl) {
          if (secondaryOverflow.value && secondaryOverflowPx.value > 0) {
            const info = secondaryInfo.value;
            const isTranslation = info?.type === "translation" || info?.type === "romanization";
            const shouldScroll = isTranslation || settings.secondaryScroll;
            if (shouldScroll) {
              const lineForProgress = isTranslation ? currentLine.value : nextLine.value;
              const lineIdx = isTranslation ? currentIndex.value : currentIndex.value + 1;
              const progress = getLineProgress(lineForProgress, lineIdx, allLines, seekMs);
              secondaryScrollEl.style.transform = `translateX(${-secondaryOverflowPx.value * progress}px)`;
            } else {
              secondaryScrollEl.style.transform = '';
            }
          } else {
            secondaryScrollEl.style.transform = '';
          }
        }
      };

      // 封面 URL
      const coverUrl = computed(() =>
        snapshot.value?.playback?.cover || snapshot.value?.playback?.coverUrl || "",
      );

      // ==================== 频谱绘制循环 ====================

      /** 停止频谱绘制循环 */
      const stopSpectrumLoop = () => {
        if (spectrumRaf) {
          cancelAnimationFrame(spectrumRaf);
          spectrumRaf = 0;
        }
        spectrumLastDraw = 0;
      };

      /** 启动频谱绘制循环（若 canvas 可用且插件启用） */
      const startSpectrumLoop = () => {
        if (!spectrumCanvas || !settings.enabled) return;
        if (!spectrumRaf) {
          spectrumRaf = requestAnimationFrame(drawSpectrumLoop);
        }
      };

      /** 频谱绘制主循环 */
      const drawSpectrumLoop = (time) => {
        spectrumRaf = requestAnimationFrame(drawSpectrumLoop);
        // 渲染帧率根据模式限制（雾状最高 24，混合最高 30，其余取用户设置）
        const mode = settings.spectrumMode || "hybrid";
        const baseFps = [15, 24, 30].includes(Number(settings.spectrumFps))
          ? Number(settings.spectrumFps)
          : 30;
        spectrumRenderFps = mode === "mist"
          ? Math.min(baseFps, 24)
          : mode === "hybrid"
            ? Math.min(baseFps, 30)
            : baseFps;
        const interval = 1000 / Math.max(10, spectrumRenderFps);
        if (time - spectrumLastDraw < interval) return;
        spectrumLastDraw = time;

        if (!spectrumCanvas) return;
        if (!settings.enabled) {
          stopSpectrumLoop();
          return;
        }

        // 独立频谱查询：按渲染节奏轮询共享分析器快照（只读，不注册订阅，
        // 停用/启用本插件时不会增删共享订阅、不会触发分析器重建，从而不干扰主界面频谱）。
        pollSpectrumSnapshot();

        const canvas = spectrumCanvas;
        if (!spectrumCtx) spectrumCtx = canvas.getContext("2d");
        const context = spectrumCtx;
        if (!context) return;

        // 尺寸自适应（DPR）
        const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
        const rect = canvas.getBoundingClientRect();
        const width = Math.max(1, Math.round(rect.width * dpr));
        const height = Math.max(1, Math.round(rect.height * dpr));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
          context.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        const logicalWidth = Math.max(1, rect.width);
        const logicalHeight = Math.max(1, rect.height);

        context.clearRect(0, 0, logicalWidth, logicalHeight);
        const frame = latestSpectrumFrame;
        const fill = settings.spectrumFill ?? 84;
        const colors = getPaletteColors(settings);
        // 背景光晕（与官方一致：无论是否播放，开关开启时都绘制）
        if (settings.showBackdrop) {
          drawSpectrumBackdrop(context, logicalWidth, logicalHeight, frame, colors);
        }
        // 有真实频谱数据时按模式绘制；否则 mist 画 idle mist、非 centered 画待机波形
        if (frame && frame.state !== "idle") {
          if (mode === "mist") {
            drawSpectrumMist(context, logicalWidth, logicalHeight, frame, settings, time, false, colors);
          } else if (mode === "centered") {
            drawSpectrumCentered(context, logicalWidth, logicalHeight, frame, settings, spectrumCenteredDisplay, colors);
          } else if (mode === "wave") {
            drawSpectrumWave(context, logicalWidth, logicalHeight, frame, fill, colors);
          } else if (mode === "hybrid") {
            drawSpectrumHybrid(context, logicalWidth, logicalHeight, frame, fill, colors);
          } else {
            drawSpectrumBars(context, logicalWidth, logicalHeight, frame, fill, colors);
          }
        } else if (mode === "mist") {
          drawSpectrumMist(context, logicalWidth, logicalHeight, frame, settings, time, true, colors);
        } else if (mode !== "centered") {
          drawSpectrumIdle(context, logicalWidth, logicalHeight, settings, time, colors);
        }
        // 透明度（canvas 内联样式）
        canvas.style.opacity = String((settings.spectrumOpacity ?? 56) / 100);
        // 背景光晕的暗色渐变（等效官方 CSS 规则）
        canvas.style.background = settings.showBackdrop
          ? "linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.1) 100%)"
          : "transparent";
      };

      // ============ 独立频谱查询（getSnapshot 轮询，不注册共享订阅） ============

      /**
       * 轮询共享分析器的频谱快照。
       * 使用只读的 getSnapshot() 而非 subscribe()：不增删共享订阅表、不触发
       * 原生分析器重建，因此停用/启用本插件不会干扰主界面（频谱可视化插件）的渲染。
       * 帧的 bins 长度由共享分析器当前配置决定（= 频谱可视化插件的柱数设置），
       * 与停用前保持一致；快照暂时取不到时保留上一帧，避免闪黑。
       */
      const pollSpectrumSnapshot = () => {
        if (!settings.enabled) return;
        if (snapshotPolling) return;
        const now = performance.now();
        const interval = 1000 / Math.max(10, spectrumRenderFps);
        if (now - snapshotLastAt < interval) return;
        snapshotLastAt = now;
        snapshotPolling = true;
        Promise.resolve()
          .then(() => ctx.audio?.spectrum?.getSnapshot?.() ?? null)
          .then((frame) => {
            if (frame && Array.isArray(frame.bins)) {
              latestSpectrumFrame = frame;
              if (!snapshotLogged) {
                snapshotLogged = true;
                console.warn("[taskbar-lyric-spectrum] 独立频谱查询收到帧", {
                  state: frame.state,
                  bins: frame.bins?.length ?? 0,
                  rms: frame.rms ?? 0,
                });
              }
            }
          })
          .catch((error) => {
            console.warn("[taskbar-lyric-spectrum] 独立频谱查询失败", error);
          })
          .finally(() => {
            snapshotPolling = false;
          });
      };

      // ==================== 歌词时钟控制 ====================

      /** 启动歌词刷新时钟（仅插件启用时有效） */
      const startClock = () => {
        if (!settings.enabled) return;
        if (!clockTimer) {
          clockTimer = setInterval(tickLyric, LYRIC_CLOCK_INTERVAL_MS);
        }
      };

      /** 停止歌词刷新时钟 */
      const stopClock = () => {
        if (clockTimer) {
          clearInterval(clockTimer);
          clockTimer = null;
        }
      };

      // 监听启用状态，动态启停绘制循环、快照查询与歌词刷新
      const stopWatchSpectrum = watch(
        () => settings.enabled,
        (enabled) => {
          if (enabled) {
            startSpectrumLoop();
            startClock();
          } else {
            stopSpectrumLoop();
            stopClock();
            latestSpectrumFrame = null;
            snapshotPolling = false;
            if (spectrumCtx && spectrumCanvas) {
              spectrumCtx.clearRect(0, 0, spectrumCanvas.clientWidth, spectrumCanvas.clientHeight);
            }
          }
        },
      );

      // ==================== 悬停控件 (v3) ====================

      const isHovered = ref(false);
      let leaveDebounce = null;
      let hoverModeTimer = null;
      let isHoverModeActive = false;
      let watchDogTimer = null;

      const cancelHoverTimer = () => {
        if (hoverModeTimer) { clearTimeout(hoverModeTimer); hoverModeTimer = null; }
      };

      const armWatchDog = () => {
        disarmWatchDog();
        watchDogTimer = setTimeout(() => {
          forceLeave();
        }, 3000);
      };
      const disarmWatchDog = () => {
        if (watchDogTimer) { clearTimeout(watchDogTimer); watchDogTimer = null; }
      };
      const onWatchDogMove = () => {
        if (isHovered.value) armWatchDog();
      };

      /** 强制离开 — 重置所有状态，恢复鼠标穿透 */
      const forceLeave = () => {
        disarmWatchDog();
        cancelHoverTimer();
        if (leaveDebounce) { clearTimeout(leaveDebounce); leaveDebounce = null; }
        isHovered.value = false;
        isHoverModeActive = false;
        document.removeEventListener('mousemove', onWatchDogMove);
        if (settings.lockPosition) {
          ctx.window.setIgnoreMouseEvents(true, { forward: true });
        } else {
          ctx.window.setIgnoreMouseEvents(false);
        }
      };

      // mouseenter 为主触发：每次边界跨越都重新启动 80ms 定时器
      const onMouseEnter = () => {
        if (!isHoverModeActive) {
          isHoverModeActive = true;
          document.addEventListener('mousemove', onWatchDogMove);
        }
        if (leaveDebounce) { clearTimeout(leaveDebounce); leaveDebounce = null; }
        cancelHoverTimer();
        isHovered.value = true;
        hoverModeTimer = setTimeout(() => {
          hoverModeTimer = null;
          if (isHovered.value && !leaveDebounce) {
            ctx.window.setIgnoreMouseEvents(false);
            armWatchDog();
          }
        }, 80);
      };

      // ——— 离开 debounce ———
      const startLeaveDebounce = () => {
        if (!isHoverModeActive) return;
        cancelHoverTimer();
        if (leaveDebounce) clearTimeout(leaveDebounce);
        leaveDebounce = setTimeout(() => {
          leaveDebounce = null;
          isHovered.value = false;
          isHoverModeActive = false;
          disarmWatchDog();
          document.removeEventListener('mousemove', onWatchDogMove);
          if (settings.lockPosition) {
            ctx.window.setIgnoreMouseEvents(true, { forward: true });
          } else {
            ctx.window.setIgnoreMouseEvents(false);
          }
        }, 150);
      };

      const onRootMouseLeave = () => { startLeaveDebounce(); };
      const onDocMouseLeave = () => { startLeaveDebounce(); };

      /** 点击浮窗空白处 → 直连主进程唤起 EchoMusic 主窗口（绕开跨分区 BroadcastChannel） */
      const onRootClick = (e) => {
        if (!settings.clickToShowMain) return;
        if (e.target.closest?.(".tb-lyric-btn")) return;
        if (ctx.host?.showOnTop) {
          ctx.host
            .showOnTop("main", { focus: true })
            .then((res) => {
              if (!res?.ok) {
                console.warn("[taskbar-lyric-spectrum] 唤起主窗口失败", res?.error || res);
              }
            })
            .catch((err) => console.warn("[taskbar-lyric-spectrum] 唤起主窗口异常", err));
        } else {
          console.warn("[taskbar-lyric-spectrum] host.showOnTop API 不可用，无法唤起主窗口");
        }
      };

      /** 切换锁定状态(控件栏锁按钮) */
      const toggleLock = async () => {
        const nextLock = !settings.lockPosition;
        settings.lockPosition = nextLock;
        if (nextLock) {
          ctx.window.setIgnoreMouseEvents(true, { forward: true });
          document.body.style.setProperty('-webkit-app-region', 'no-drag');
          await captureOffsetsFromPosition();
        } else {
          ctx.window.setIgnoreMouseEvents(false);
          document.body.style.setProperty('-webkit-app-region', 'drag');
        }
        try {
          const saved = await ctx.storage.get("settings");
          await ctx.storage.set("settings", { ...(saved || {}), lockPosition: nextLock });
        } catch { /* 静默忽略 */ }
      };

      // ==================== SVG 矢量图标 ====================

      /** 锁图标 — Feather Icons 风格描边 SVG */
      const lockIcon = (open) => h("svg", {
        width: 16, height: 16, viewBox: "0 0 24 24",
        fill: "none", stroke: "currentColor",
        "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round",
      }, [
        h("rect", { x: 5, y: 11, width: 14, height: 10, rx: 2 }),
        h("path", {
          d: open
            ? "M8 11V7a4 4 0 0 1 7.8-1"
            : "M8 11V7a4 4 0 0 1 8 0v4",
        }),
      ]);

      /** 喜欢图标 — 实心/空心心形 SVG */
      const heartIcon = (liked) => h("svg", {
        width: 16, height: 16, viewBox: "0 0 24 24",
        fill: liked ? "#ff2d55" : "none",
        stroke: liked ? "#ff2d55" : "currentColor",
        "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round",
      }, [
        h("path", {
          d: "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z",
        }),
      ]);

      /** 不喜欢图标 — 心形带斜线（FM 模式用） */
      const dislikeIcon = () => h("svg", {
        width: 16, height: 16, viewBox: "0 0 24 24",
        fill: "none", stroke: "currentColor",
        "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round",
      }, [
        h("path", {
          d: "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z",
        }),
        h("line", { x1: 1, y1: 1, x2: 23, y2: 23 }),
      ]);

      // ==================== 喜欢状态（来源：snapshot） ====================

      const isLiked = computed(() => snapshot.value?.playback?.isFavorite ?? false);

      /** FM 模式检测 */
      const isPersonalFM = computed(() => snapshot.value?.playback?.isPersonalFM ?? false);

      /** 收藏切换（控件按钮调用） */
      const toggleFavorite = () => {
        ctx.nowPlaying.command('toggleFavorite').catch(() => {});
      };

      /** FM 不喜欢：上报 garbage + 切下一首 */
      const dislikeFm = async () => {
        if (ctx.player && typeof ctx.player.dislikePersonalFm === 'function') {
          try {
            await ctx.player.dislikePersonalFm();
            return;
          } catch (e) {
            // fall through
          }
        }
        try {
          channel?.postMessage({ type: "command", command: "dislikeFm" });
        } catch {}
        ctx.nowPlaying.command("nextTrack").catch(() => {});
      };

      /**
       * 渲染卡拉OK 效果的歌词文本
       */
      const renderKaraokeText = (text, line, seekMs, isActive) => {
        if (!isActive || !line) return text;

        const playedColor = settings.playedColor;
        const unplayedColor = settings.unplayedColor;
        const bgImage = `linear-gradient(to right, ${playedColor} 50%, ${unplayedColor} 50%)`;

        // 逐字歌词(YRC 格式)
        if (isYrcLine(line)) {
          const chars = line.characters || [];
          if (currentActiveLineIndex !== currentIndex.value) {
            currentActiveLineIndex = currentIndex.value;
            currentActiveCharEls = new Array(chars.length).fill(null);
            currentActiveWholeSpan = null;
          }
          return chars.map((char, i) => {
            const duration = Math.max((char.endTime || 0) - (char.startTime || 0), 0.001);
            const progress = Math.max(Math.min((seekMs - (char.startTime || 0)) / duration, 1), 0);
            return h("span", {
              key: i,
              class: "tb-lyric-char",
              style: {
                backgroundImage: bgImage,
                backgroundPositionX: `${100 - progress * 100}%`,
              },
              ref: (el) => {
                if (el) {
                  currentActiveCharEls[i] = el;
                }
              },
            }, char.text || "");
          });
        }

        // 非逐字歌词: 整体渐变
        if (currentActiveLineIndex !== currentIndex.value) {
          currentActiveLineIndex = currentIndex.value;
          currentActiveCharEls = [];
          currentActiveWholeSpan = null;
        }
        const lineStart = getLineStartMs(line);
        const chars = line.characters || [];
        let lineEnd;
        if (chars.length > 0) {
          lineEnd = chars[chars.length - 1]?.endTime ?? 0;
        } else {
          const nextIdx = currentIndex.value + 1;
          const lines = snapshot.value?.lyric?.lines ?? [];
          lineEnd = nextIdx < lines.length ? getLineStartMs(lines[nextIdx]) : lineStart + 5000;
        }
        const duration = Math.max(lineEnd - lineStart, 1);
        const progress = Math.max(0, Math.min(1, (seekMs - lineStart) / duration));

        return h("span", {
          class: "tb-lyric-char",
          style: {
            backgroundImage: bgImage,
            backgroundPositionX: `${100 - progress * 100}%`,
          },
          ref: (el) => { currentActiveWholeSpan = el; },
        }, text);
      };

      // ==================== 生命周期 ====================

      onMounted(async () => {
        // 1. 先建立 BroadcastChannel 监听(防止竞态)
        setupChannel();

        // 1b. 快速轮询主入口写入的主题色（单一 storage 同步方案，双端 50ms）
        paletteSyncTimer = setInterval(() => { applyPaletteSync(); }, SPECTRUM_PALETTE_SYNC_INTERVAL_MS);
        await applyPaletteSync();

        // 2. 获取当前播放快照
        snapshot.value = await ctx.nowPlaying.getSnapshot();
        snapshotDispose = ctx.nowPlaying.onSnapshot((next) => {
          snapshot.value = next;
          tickLyric();
        });

        // 3. 启动歌词刷新时钟
        startClock();

        // 4. 从存储加载初始设置(仅作为 channel 尚未到达时的回退)
        if (!receivedFromChannel) {
          const saved = await ctx.storage.get("settings");
          if (saved && typeof saved === "object") {
            Object.assign(settings, saved);
          }
        }

        // 5. 定位窗口到任务栏上方
        positionToTaskbar(ctx, settings);

        // 6. 启动 storage 轮询(BroadcastChannel 后备方案)
        settingsSyncTimer = setInterval(async () => {
          if (receivedFromChannel) return;
          try {
            const saved = await ctx.storage.get("settings");
            if (!saved || typeof saved !== "object") return;
            const hash = JSON.stringify(saved);
            if (hash === lastSettingsHash) return;
            lastSettingsHash = hash;

            const wasLocked = settings.lockPosition;
            const snapX = window.screenX;
            const snapY = window.screenY;
            const oldWidth = settings.windowWidth;
            const oldOffsetX = settings.taskbarOffsetX;

            Object.assign(settings, saved);

            if (!wasLocked && settings.lockPosition && snapX !== undefined) {
              const base = computeWindowBounds({ ...settings, taskbarOffsetX: 0, taskbarOffsetY: 0, manualAdjust: true });
              const dx = snapX - base.x;
              const dy = snapY - base.y;
              const taskbar = base.taskbar;
              const pctX = Math.round((dx / Math.max((taskbar.screenWidth - base.width) / 2, 1)) * 100);
              const pctY = Math.round((dy / Math.max(taskbar.screenHeight / 4, taskbar.size * 3, 1)) * 100);
              settings.taskbarOffsetX = clamp(pctX, -100, 100);
              settings.taskbarOffsetY = clamp(pctY, -100, 100);
              ctx.storage.set("settings", { ...saved, taskbarOffsetX: settings.taskbarOffsetX, taskbarOffsetY: settings.taskbarOffsetY }).catch(() => {});
            }

            if (settings.windowWidth !== oldWidth && settings.taskbarOffsetX === oldOffsetX) {
              const leftEdge = window.screenX;
              const isRightCover = settings.coverPosition === "right";
              const anchorEdge = isRightCover ? leftEdge + oldWidth : leftEdge;
              const targetX = isRightCover ? anchorEdge - settings.windowWidth : anchorEdge;
              const tb = detectTaskbarInfo();
              const centerX = Math.round((tb.screenWidth - settings.windowWidth) / 2);
              if (centerX > 0) {
                const pct = Math.round((targetX / centerX - 1) * 100);
                settings.taskbarOffsetX = clamp(pct, -100, 100);
                ctx.storage.set("settings", { ...saved, taskbarOffsetX: settings.taskbarOffsetX }).catch(() => {});
              }
            }

            positionToTaskbar(ctx, settings);
          } catch { /* storage 轮询失败静默忽略 */ }
        }, 1000);

        // 7. 屏幕几何变化检测
        let lastScreenKey = null;
        const checkScreenAndReposition = () => {
          const info = detectTaskbarInfo();
          const key = `${info.position}|${info.size}|${info.screenWidth}|${info.screenHeight}`;
          if (lastScreenKey !== key) {
            lastScreenKey = key;
            if (settings.lockPosition) positionToTaskbar(ctx, settings);
          }
        };
        checkScreenAndReposition();

        // 8. 窗口心跳：每 2s 通过 BroadcastChannel 发心跳到主插件
        let keepaliveTimer = setInterval(() => {
          channel?.postMessage({ type: "heartbeat", ts: Date.now() });
          checkScreenAndReposition();
        }, 2000);
        channel?.postMessage({ type: "heartbeat", ts: Date.now() });

        // 9. resize 事件快速响应
        const onScreenResize = () => { checkScreenAndReposition(); };
        window.addEventListener('resize', onScreenResize);

        // 9b. 悬停离开兜底
        document.addEventListener('mouseleave', onDocMouseLeave);

        // 9c. 一次性 mousemove 快照
        let initHoverSnapshot = null;
        let initHoverTimer = setTimeout(() => {
          document.removeEventListener('mousemove', initHoverSnapshot);
          initHoverSnapshot = null;
        }, 600);
        initHoverSnapshot = () => {
          if (leaveDebounce) return;
          isHoverModeActive = true;
          document.addEventListener('mousemove', onWatchDogMove);
          cancelHoverTimer();
          isHovered.value = true;
          hoverModeTimer = setTimeout(() => {
            hoverModeTimer = null;
            if (isHovered.value && !leaveDebounce) {
              ctx.window.setIgnoreMouseEvents(false);
              armWatchDog();
            }
          }, 80);
          clearTimeout(initHoverTimer);
          document.removeEventListener('mousemove', initHoverSnapshot);
          initHoverSnapshot = null;
        };
        document.addEventListener('mousemove', initHoverSnapshot);

        // 10. 桌面歌词级置顶
        ctx.window.setAlwaysOnTop(true, 'screen-saver');

        // 11. 根据锁定状态设置鼠标穿透与拖拽
        if (settings.lockPosition) {
          ctx.window.setIgnoreMouseEvents(true, { forward: true });
          document.body.style.setProperty('-webkit-app-region', 'no-drag');
        } else {
          ctx.window.setIgnoreMouseEvents(false);
          document.body.style.setProperty('-webkit-app-region', 'drag');
        }

        // 12. 启动频谱：浮窗独立轮询 getSnapshot()（不注册共享订阅，不影响主界面频谱）
        if (settings.enabled) {
          startSpectrumLoop();
        }

        // 13. 淡入显示窗口
        requestAnimationFrame(() => {
          document.documentElement.classList.add("tb-lyric-visible");
          checkOverflow();
        });
      });

      /**
       * 捕获当前窗口位置,反算偏移值并持久化
       */
      const captureOffsetsFromPosition = async () => {
        try {
          const wx = window.screenX;
          const wy = window.screenY;
          if (wx === undefined || wy === undefined) return;
          const base = computeWindowBounds({ ...settings, taskbarOffsetX: 0, taskbarOffsetY: 0, manualAdjust: true });
          const dx = wx - base.x;
          const dy = wy - base.y;
          const taskbar = base.taskbar;
          const pctX = Math.round((dx / Math.max((taskbar.screenWidth - base.width) / 2, 1)) * 100);
          const pctY = Math.round((dy / Math.max(taskbar.screenHeight / 4, taskbar.size * 3, 1)) * 100);
          const newOx = clamp(pctX, -100, 100);
          const newOy = clamp(pctY, -100, 100);
          settings.taskbarOffsetX = newOx;
          settings.taskbarOffsetY = newOy;
          const saved = await ctx.storage.get("settings");
          await ctx.storage.set("settings", { ...(saved || {}), taskbarOffsetX: newOx, taskbarOffsetY: newOy });
        } catch { /* 静默忽略 */ }
      };

      onBeforeUnmount(() => {
        stopWatchPosition?.();
        stopWatchLock?.();
        stopWatchOverflow?.();
        stopWatchSpectrum?.();
        stopSpectrumLoop();

        window.removeEventListener('resize', onScreenResize);
        document.removeEventListener('mouseleave', onDocMouseLeave);
        if (initHoverSnapshot) { document.removeEventListener('mousemove', initHoverSnapshot); clearTimeout(initHoverTimer); }
        if (hoverModeTimer) clearTimeout(hoverModeTimer);
        if (leaveDebounce) clearTimeout(leaveDebounce);
        disarmWatchDog();
        document.removeEventListener('mousemove', onWatchDogMove);
        snapshotDispose?.();
        stopClock();
        if (settingsSyncTimer) clearInterval(settingsSyncTimer);
        if (paletteSyncTimer) clearInterval(paletteSyncTimer);
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        channel?.close();
      });

      // 监听窗口尺寸 + 偏移 + 手动调整 变化,重新定位
      const stopWatchPosition = watch(
        () => [settings.windowWidth, settings.windowHeight, settings.taskbarOffsetX, settings.taskbarOffsetY, settings.manualAdjust],
        () => {
          positionToTaskbar(ctx, settings);
        },
      );

      // 监听锁定状态变化
      const stopWatchLock = watch(
        () => settings.lockPosition,
        (lock) => {
          if (lock) {
            ctx.window.setIgnoreMouseEvents(true, { forward: true });
            document.body.style.setProperty('-webkit-app-region', 'no-drag');
          } else {
            ctx.window.setIgnoreMouseEvents(false);
            document.body.style.setProperty('-webkit-app-region', 'drag');
          }
          if (lock) {
            captureOffsetsFromPosition();
          }
        },
      );

      // 监听歌词文本或窗口宽度变化 → 检测溢出
      const stopWatchOverflow = watch(
        () => [currentText.value, secondaryText.value, settings.windowWidth],
        async () => {
          await nextTick();
          checkOverflow();
        },
      );

      // ==================== 渲染 ====================

      return () => {
        const showCover = settings.showCover && coverUrl.value;
        const coverOnLeft = settings.coverPosition === "left";
        const fontFamilyStyle = settings.fontFamily || undefined;
        const snap = snapshot.value;
        const seekMs = getLyricSeekMs(snap || {});
        const textAlign = coverOnLeft ? "left" : "right";
        const isPlaying = snap?.playback?.isPlaying;
        const liked = isLiked.value;

        const primaryStyle = {
          fontSize: `${settings.lyricFontSize}px`,
          fontFamily: fontFamilyStyle,
          color: settings.playedColor,
          textAlign,
        };

        const secondaryStyle = {
          fontSize: `${settings.secondaryFontSize}px`,
          fontFamily: fontFamilyStyle,
          color: settings.unplayedColor,
          textAlign,
        };

        // 频谱画布（置于底层）
        const spectrumElement = h("canvas", {
          class: "tb-lyric-spectrum",
          style: { opacity: (settings.spectrumOpacity ?? 56) / 100 },
          ref: (el) => { spectrumCanvas = el; },
        });

        // 封面元素
        const coverElement = showCover
          ? h("div", {
              class: ["tb-lyric-cover", settings.coverShape],
              style: {
                width: `${settings.coverSize}px`,
                height: `${settings.coverSize}px`,
              },
            }, [
              h("img", { src: coverUrl.value, alt: "", draggable: "false" }),
            ])
          : null;

        // 主歌词(卡拉OK着色,包在滚动容器内)
        const primaryContent = renderKaraokeText(
          currentText.value, currentLine.value, seekMs, true,
        );

        // 歌词文本容器
        const textElement = h("div", { class: "tb-lyric-text", style: { textAlign } }, [
          h("div", {
            class: ["tb-lyric-primary", primaryOverflow.value ? "tb-lyric-overflow" : ""],
            style: primaryStyle,
          }, [
            h("div", {
              class: "tb-lyric-scroll",
              ref: (el) => { primaryScrollEl = el; },
            }, Array.isArray(primaryContent) ? primaryContent : [primaryContent]),
          ]),
          secondaryText.value
            ? h("div", {
                class: ["tb-lyric-secondary", secondaryOverflow.value ? "tb-lyric-overflow" : ""],
                style: secondaryStyle,
              }, [
                h("div", {
                  class: "tb-lyric-scroll",
                  ref: (el) => { secondaryScrollEl = el; },
                }, secondaryText.value),
              ])
            : null,
        ]);

        // 悬停控件栏
        const controlsElement = h("div", { class: "tb-lyric-controls" }, [
          isPersonalFM.value
            ? h("button", {
                class: ["tb-lyric-btn", "tb-lyric-btn-icon"],
                title: "不喜欢",
                onClick: (e) => { e.stopPropagation(); dislikeFm(); },
              }, dislikeIcon())
            : h("button", {
                class: "tb-lyric-btn",
                title: "上一首",
                onClick: (e) => { e.stopPropagation(); ctx.nowPlaying.command("previousTrack").catch(() => {}); },
              }, "\u23EE"),
          h("button", {
            class: ["tb-lyric-btn", "tb-lyric-btn-play"],
            title: isPlaying ? "暂停" : "播放",
            onClick: (e) => { e.stopPropagation(); ctx.nowPlaying.command("togglePlayback").catch(() => {}); },
          }, isPlaying ? "\u23F8" : "\u25B6"),
          h("button", {
            class: "tb-lyric-btn",
            title: "下一首",
            onClick: (e) => { e.stopPropagation(); ctx.nowPlaying.command("nextTrack").catch(() => {}); },
          }, "\u23ED"),
          h("button", {
            class: ["tb-lyric-btn", "tb-lyric-btn-icon"],
            title: liked ? "取消喜欢" : "喜欢",
            onClick: (e) => { e.stopPropagation(); toggleFavorite(); },
          }, heartIcon(liked)),
          settings.showLockButton
            ? h("button", {
                class: ["tb-lyric-btn", "tb-lyric-btn-icon"],
                title: settings.lockPosition ? "解锁" : "锁定",
                onClick: (e) => { e.stopPropagation(); toggleLock(); },
              }, lockIcon(!settings.lockPosition))
            : null,
        ]);

        const lyricChildren = coverOnLeft
          ? [coverElement, textElement, controlsElement]
          : [textElement, coverElement, controlsElement];

        const children = [spectrumElement, ...lyricChildren];

        return h("div", {
          class: ["tb-lyric-root", showCover ? "has-cover" : "", isHovered.value ? "tb-lyric-hover" : ""],
          onMouseenter: onMouseEnter,
          onMouseleave: onRootMouseLeave,
          onClick: onRootClick,
        }, children);
      };
    },
  };

  const app = createApp(App);
  app.mount(ctx.container);
  ctx.dispose(() => app.unmount());
}