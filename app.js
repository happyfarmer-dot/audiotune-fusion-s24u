/**
 * AudioTune Fusion Web - Main Application Controller & Canvas Visualizers
 * Samsung Galaxy S24 Ultra Mobile PWA
 */

import {
  computeGCCPHAT,
  computeMonoPhaseCoherence,
  analyzeSpectrumAndModes,
  estimateRT60,
} from './dsp.js';
import { SensorFusionManager } from './sensors.js';

const STORAGE_KEY = 'audiotune_s24u_snapshots_v1';

class AudioTuneApp {
  constructor() {
    this.sensors = new SensorFusionManager();
    this.activeTab = 'phase'; // 'phase' | 'cabinet' | 'emi' | 'compare'
    this.rafId = null;

    // Latest live metrics for snapshots
    this.metrics = {
      mode: '待機',
      deltaTMs: 0,
      doaDeg: 0,
      adjustCm: 0,
      confidence: 0,
      monoCoherence: 0,
      noiseFloorDb: -90,
      primaryModeHz: 0,
      primaryModeDb: -90,
      modes: [],
      rt60: null,
      dampingScore: 100,
      rmsG: 0,
      cabinetPeakHz: 0,
      ulfDb: -80,
      emiIndex: 0,
      emiStatus: 'safe',
      magEngine: 'none',
    };

    // Waterfall buffer (rows of 20-250 Hz spectrum)
    this.waterfallRows = [];
    this.maxWaterfallRows = 72;
    this.peakHoldDb = null;

    // RT60 measurement state
    this.rt60State = 'idle'; // 'idle' | 'armed' | 'capturing'
    this.rt60PeakDb = -90;
    this.rt60DecaySeries = [];
    this.rt60LastSampleTime = 0;

    // EMI history for strip chart
    this.emiHistory = [];

    // Snapshots
    this.snapshots = this._loadSnapshots();
    this.compareBeforeId = null;
    this.compareAfterId = null;

    this._initUI();
    this._bindEvents();
    this._renderSnapshotsUI();
    this._startRenderLoop();
  }

  _initUI() {
    this.dom = {
      btnActivateAll: document.getElementById('btn-activate-all'),
      ledMic: document.getElementById('led-mic'),
      ledAccel: document.getElementById('led-accel'),
      ledMag: document.getElementById('led-mag'),
      badgeWake: document.getElementById('badge-wake'),
      statusBanner: document.getElementById('status-banner'),

      // Tab navigation
      tabButtons: document.querySelectorAll('[data-tab]'),
      tabPanels: document.querySelectorAll('[data-panel]'),

      // Module 1: Phase & Standing Wave
      modeBadge: document.getElementById('audio-mode-badge'),
      canvasCompass: document.getElementById('canvas-compass'),
      canvasWaterfall: document.getElementById('canvas-waterfall'),
      valDoa: document.getElementById('val-doa'),
      valDeltaT: document.getElementById('val-deltat'),
      valAdjustCm: document.getElementById('val-adjust-cm'),
      valNoiseDb: document.getElementById('val-noise-db'),
      valRt60: document.getElementById('val-rt60'),
      btnMeasureRt60: document.getElementById('btn-measure-rt60'),
      modesList: document.getElementById('standing-modes-list'),

      // Signal Generator
      genButtons: document.querySelectorAll('[data-gen]'),
      btnGenStop: document.getElementById('btn-gen-stop'),
      sliderGenVol: document.getElementById('slider-gen-vol'),
      valGenVol: document.getElementById('val-gen-vol'),
      lfFreqWrap: document.getElementById('lf-freq-wrap'),
      sliderLfFreq: document.getElementById('slider-lf-freq'),
      valLfFreq: document.getElementById('val-lf-freq'),

      // Module 2: Cabinet Resonance
      canvasCabinet: document.getElementById('canvas-cabinet'),
      valDampingScore: document.getElementById('val-damping-score'),
      dampingBadge: document.getElementById('damping-badge'),
      valRmsG: document.getElementById('val-rms-g'),
      valCabPeakHz: document.getElementById('val-cab-peak-hz'),
      valAccelRate: document.getElementById('val-accel-rate'),
      valUlfDb: document.getElementById('val-ulf-db'),

      // Module 3: EMI / Magnetometer
      canvasEmi: document.getElementById('canvas-emi'),
      magEngineBadge: document.getElementById('mag-engine-badge'),
      valEmiIndex: document.getElementById('val-emi-index'),
      emiStatusBadge: document.getElementById('emi-status-badge'),
      valMagStatic: document.getElementById('val-mag-static'),
      valMagJitter: document.getElementById('val-mag-jitter'),
      btnMagCalibrate: document.getElementById('btn-mag-calibrate'),
      toggleHaptic: document.getElementById('toggle-haptic'),
      sliderEmiThresh: document.getElementById('slider-emi-thresh'),
      valEmiThresh: document.getElementById('val-emi-thresh'),
      magFlagHint: document.getElementById('mag-flag-hint'),

      // Module 4: Snapshots & Compare
      inputSnapLabel: document.getElementById('input-snap-label'),
      btnSaveSnap: document.getElementById('btn-save-snap'),
      btnExportJson: document.getElementById('btn-export-json'),
      btnClearSnaps: document.getElementById('btn-clear-snaps'),
      selectBefore: document.getElementById('select-before'),
      selectAfter: document.getElementById('select-after'),
      compareGrid: document.getElementById('compare-grid'),
      snapHistoryList: document.getElementById('snap-history-list'),
    };
  }

  _bindEvents() {
    this.sensors.onStatusChange = (status) => this._updateStatusLEDs(status);
    this.sensors.onSweepFreqUpdate = (freq) => {
      this.dom.valLfFreq.textContent = `${freq.toFixed(1)} Hz`;
    };

    // One-click Activate All
    this.dom.btnActivateAll.addEventListener('click', async () => {
      this.dom.btnActivateAll.disabled = true;
      this.dom.btnActivateAll.textContent = '啟動授權中...';
      const res = await this.sensors.activateAll();
      this.dom.btnActivateAll.disabled = false;

      if (res.errors.length === 0) {
        this.dom.btnActivateAll.textContent = '感應器運作中 ✓';
        this.dom.btnActivateAll.classList.remove('bg-amber-500', 'text-slate-950');
        this.dom.btnActivateAll.classList.add('bg-emerald-500/20', 'text-emerald-300', 'border', 'border-emerald-500/50');
        this._showBanner('所有感應器與螢幕常亮已就緒', 'emerald');
      } else {
        this.dom.btnActivateAll.textContent = '部分啟動 (點擊重試)';
        this._showBanner(`部分感應器未授權：${res.errors.join(' | ')}`, 'amber');
      }
    });

    // Bottom Navigation Tabs
    this.dom.tabButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-tab');
        this._switchTab(target);
      });
    });

    // Signal Generator buttons
    this.dom.genButtons.forEach((btn) => {
      btn.addEventListener('click', async () => {
        const mode = btn.getAttribute('data-gen');
        await this.sensors.startGenerator(mode, Number(this.dom.sliderLfFreq.value));
        this._updateGeneratorUI(mode);
      });
    });

    this.dom.btnGenStop.addEventListener('click', () => {
      this.sensors.stopGenerator();
      this._updateGeneratorUI('off');
    });

    this.dom.sliderGenVol.addEventListener('input', (e) => {
      const vol = Number(e.target.value) / 100;
      this.sensors.setGeneratorVolume(vol);
      this.dom.valGenVol.textContent = `${e.target.value}%`;
    });

    this.dom.sliderLfFreq.addEventListener('input', (e) => {
      const freq = Number(e.target.value);
      this.dom.valLfFreq.textContent = `${freq} Hz`;
      this.sensors.setManualFrequency(freq);
    });

    // RT60 Measure Button
    this.dom.btnMeasureRt60.addEventListener('click', () => {
      if (!this.sensors.micActive) {
        this._showBanner('請先點擊頂部「一鍵啟動全部感應器」開啟麥克風', 'amber');
        return;
      }
      this.rt60State = 'armed';
      this.rt60DecaySeries = [];
      this.dom.btnMeasureRt60.textContent = '請拍手或播放脈衝...';
      this.dom.btnMeasureRt60.classList.add('animate-pulse', 'border-amber-400', 'text-amber-300');
    });

    // Magnetometer Calibration & Haptic Controls
    this.dom.btnMagCalibrate.addEventListener('click', () => {
      this.sensors.calibrateMagnetometer();
      this._showBanner('磁場基準已歸零校準', 'cyan');
    });

    this.dom.toggleHaptic.addEventListener('change', (e) => {
      this.sensors.hapticEnabled = e.target.checked;
    });

    this.dom.sliderEmiThresh.addEventListener('input', (e) => {
      const val = Number(e.target.value);
      this.sensors.emiThreshold = val;
      this.dom.valEmiThresh.textContent = `${val}`;
    });

    // Snapshots & Compare
    this.dom.btnSaveSnap.addEventListener('click', () => this._saveCurrentSnapshot());
    this.dom.btnExportJson.addEventListener('click', () => this._exportJsonReport());
    this.dom.btnClearSnaps.addEventListener('click', () => {
      if (confirm('確定要清除所有調音紀錄嗎？')) {
        this.snapshots = [];
        this._persistSnapshots();
        this._renderSnapshotsUI();
      }
    });

    this.dom.selectBefore.addEventListener('change', (e) => {
      this.compareBeforeId = e.target.value;
      this._renderCompareCards();
    });
    this.dom.selectAfter.addEventListener('change', (e) => {
      this.compareAfterId = e.target.value;
      this._renderCompareCards();
    });
  }

  _switchTab(tabId) {
    this.activeTab = tabId;
    this.dom.tabButtons.forEach((btn) => {
      const isActive = btn.getAttribute('data-tab') === tabId;
      btn.classList.toggle('text-amber-400', isActive);
      btn.classList.toggle('text-slate-400', !isActive);
    });
    this.dom.tabPanels.forEach((panel) => {
      const isMatch = panel.getAttribute('data-panel') === tabId;
      panel.classList.toggle('hidden', !isMatch);
    });
  }

  _updateGeneratorUI(activeMode) {
    this.dom.genButtons.forEach((btn) => {
      const isSelected = btn.getAttribute('data-gen') === activeMode;
      btn.classList.toggle('bg-amber-500', isSelected);
      btn.classList.toggle('text-slate-950', isSelected);
      btn.classList.toggle('font-bold', isSelected);
      btn.classList.toggle('bg-slate-800', !isSelected);
      btn.classList.toggle('text-slate-200', !isSelected);
    });
    this.dom.lfFreqWrap.classList.toggle('hidden', activeMode !== 'lf_manual' && activeMode !== 'lf_sweep');
    this.dom.sliderLfFreq.disabled = activeMode === 'lf_sweep';
  }

  _updateStatusLEDs(status) {
    const setLed = (el, on) => {
      el.classList.toggle('bg-emerald-400', on);
      el.classList.toggle('shadow-[0_0_8px_#34d399]', on);
      el.classList.toggle('bg-slate-600', !on);
    };
    setLed(this.dom.ledMic, status.micActive);
    setLed(this.dom.ledAccel, status.accelActive);
    setLed(this.dom.ledMag, status.magActive);

    if (status.wakeLockActive) {
      this.dom.badgeWake.textContent = '常亮 ON';
      this.dom.badgeWake.className = 'text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40';
    } else {
      this.dom.badgeWake.textContent = '常亮 OFF';
      this.dom.badgeWake.className = 'text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700';
    }

    if (status.micActive) {
      if (status.isStereo) {
        this.dom.modeBadge.textContent = '雙聲道立體聲 GCC-PHAT (0.162m)';
        this.dom.modeBadge.className = 'text-xs px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/40';
        this.metrics.mode = '立體聲 GCC-PHAT';
      } else {
        this.dom.modeBadge.textContent = '單聲道脈衝對齊 + 駐波偵測';
        this.dom.modeBadge.className = 'text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40';
        this.metrics.mode = '單聲道相干偵測';
      }
    }

    if (status.magActive) {
      if (status.magEngine === 'generic') {
        this.dom.magEngineBadge.textContent = '主引擎: Generic Sensor (µT 原始磁通)';
        this.dom.magEngineBadge.className = 'text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40';
        this.dom.magFlagHint.classList.add('hidden');
        this.metrics.magEngine = 'Generic Sensor (µT)';
      } else {
        this.dom.magEngineBadge.textContent = '備援引擎: 絕對地磁羅盤偏轉偵測';
        this.dom.magEngineBadge.className = 'text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40';
        this.dom.magFlagHint.classList.remove('hidden');
        this.metrics.magEngine = 'Compass Fallback (deg)';
      }
    }
  }

  _showBanner(msg, color = 'amber') {
    const el = this.dom.statusBanner;
    el.textContent = msg;
    el.className = `mx-3 mt-2 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
      color === 'emerald'
        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
        : color === 'cyan'
          ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40'
          : 'bg-amber-500/15 text-amber-300 border-amber-500/40'
    }`;
    el.classList.remove('hidden');
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => {
      el.classList.add('hidden');
    }, 4500);
  }

  /* ==================== Main 60fps DSP & Render Loop ==================== */
  _startRenderLoop() {
    const loop = (now) => {
      this._processFrame(now);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  _processFrame(now) {
    // 1. Read & process Web Audio
    const audio = this.sensors.readAudioFrames();
    if (audio) {
      const spec = analyzeSpectrumAndModes(audio.left, audio.sampleRate, this.sensors.hann4096);
      this.metrics.noiseFloorDb = spec.dbfs;
      this.metrics.modes = spec.modes;
      this.metrics.ulfDb = audio.ulfEnvelopeDb;

      if (spec.modes.length > 0) {
        this.metrics.primaryModeHz = spec.modes[0].freq;
        this.metrics.primaryModeDb = spec.modes[0].db;
      }

      this._processRT60(spec.dbfs, now);
      this._pushWaterfall(spec);

      let phaseData = null;
      if (audio.isStereo && audio.right) {
        phaseData = computeGCCPHAT(audio.left, audio.right, audio.sampleRate, this.sensors.hann4096);
        this.metrics.deltaTMs = phaseData.deltaTMs;
        this.metrics.doaDeg = phaseData.doaDeg;
        this.metrics.adjustCm = phaseData.adjustCm;
        this.metrics.confidence = phaseData.confidence;
      } else {
        phaseData = computeMonoPhaseCoherence(audio.left, audio.sampleRate, this.sensors.hann4096);
        this.metrics.monoCoherence = phaseData.coherence;
        this.metrics.doaDeg = phaseData.phaseAngleDeg;
      }

      if (this.activeTab === 'phase') {
        this._updatePhaseUI(audio.isStereo, phaseData, spec);
        this._drawCompass(audio.isStereo, phaseData);
        this._drawWaterfall(spec);
      }
    } else if (this.activeTab === 'phase') {
      this._drawCompassPlaceholder();
    }

    // 2. Module 2: Cabinet Resonance
    if (this.sensors.accelActive) {
      this.metrics.dampingScore = this.sensors.dampingScore;
      this.metrics.rmsG = this.sensors.accelRmsG;
      this.metrics.cabinetPeakHz = this.sensors.accelPeakHz;

      if (this.activeTab === 'cabinet') {
        this._updateCabinetUI();
        this._drawCabinetCanvas();
      }
    }

    // 3. Module 3: EMI / Magnetometer
    if (this.sensors.magActive) {
      this.metrics.emiIndex = this.sensors.emiIndex;
      this.metrics.emiStatus = this.sensors.emiStatus;
      this.emiHistory.push(this.sensors.emiIndex);
      if (this.emiHistory.length > 140) this.emiHistory.shift();

      if (this.activeTab === 'emi') {
        this._updateEmiUI();
        this._drawEmiCanvas();
      }
    }
  }

  _processRT60(currentDb, now) {
    if (this.rt60State === 'armed') {
      // Trigger when sudden impulse (> -32 dBFS and jump > 12 dB above ambient)
      if (currentDb > -35) {
        this.rt60State = 'capturing';
        this.rt60PeakDb = currentDb;
        this.rt60DecaySeries = [currentDb];
        this.rt60LastSampleTime = now;
        this.dom.btnMeasureRt60.textContent = '擷取殘響衰減中...';
      }
    } else if (this.rt60State === 'capturing') {
      if (now - this.rt60LastSampleTime >= 25) {
        this.rt60LastSampleTime = now;
        this.rt60DecaySeries.push(currentDb);
        if (this.rt60DecaySeries.length >= 48) {
          // 1.2s capture window
          const res = estimateRT60(this.rt60DecaySeries, 0.025);
          if (res.valid) {
            this.metrics.rt60 = res.rt60;
            this.dom.valRt60.textContent = `${res.rt60.toFixed(2)} s`;
            this._showBanner(`RT60 量測完成：${res.rt60.toFixed(2)} 秒 (衰減 ${res.dropDb.toFixed(1)} dB)`, 'emerald');
          } else {
            this._showBanner('脈衝能量衰減不足，請靠近喇叭再拍手重試', 'amber');
          }
          this.rt60State = 'idle';
          this.dom.btnMeasureRt60.textContent = '測量 RT60 (拍手/脈衝)';
          this.dom.btnMeasureRt60.classList.remove('animate-pulse', 'border-amber-400', 'text-amber-300');
        }
      }
    }
  }

  _pushWaterfall(spec) {
    // Extract 20-250 Hz bins
    const minBin = Math.max(1, Math.floor(20 / spec.binHz));
    const maxBin = Math.min(spec.magDb.length - 1, Math.ceil(250 / spec.binHz));
    const row = [];
    for (let k = minBin; k <= maxBin; k++) {
      row.push(spec.magDb[k]);
    }
    this.waterfallRows.unshift(row);
    if (this.waterfallRows.length > this.maxWaterfallRows) {
      this.waterfallRows.pop();
    }

    if (!this.peakHoldDb || this.peakHoldDb.length !== row.length) {
      this.peakHoldDb = Float32Array.from(row);
    } else {
      for (let i = 0; i < row.length; i++) {
        this.peakHoldDb[i] = Math.max(row[i], this.peakHoldDb[i] - 0.15);
      }
    }
  }

  _updatePhaseUI(isStereo, phaseData, spec) {
    this.dom.valNoiseDb.textContent = `${spec.dbfs.toFixed(1)} dB`;

    if (isStereo) {
      this.dom.valDoa.textContent = `${phaseData.doaDeg >= 0 ? '+' : ''}${phaseData.doaDeg.toFixed(1)}°`;
      this.dom.valDeltaT.textContent = `${phaseData.deltaTMs >= 0 ? '+' : ''}${phaseData.deltaTMs.toFixed(2)} ms`;
      const absCm = Math.abs(phaseData.adjustCm);
      if (absCm < 0.8) {
        this.dom.valAdjustCm.textContent = '已對齊 ✓';
        this.dom.valAdjustCm.className = 'text-base font-bold text-emerald-400 tabular-nums';
      } else {
        const dir = phaseData.adjustCm > 0 ? '右/後移' : '左/前移';
        this.dom.valAdjustCm.textContent = `${dir} ${absCm.toFixed(1)} cm`;
        this.dom.valAdjustCm.className = 'text-base font-bold text-amber-400 tabular-nums';
      }
    } else {
      this.dom.valDoa.textContent = `${(phaseData.coherence * 100).toFixed(0)}% 相干`;
      this.dom.valDeltaT.textContent = `${phaseData.crestFactorDb.toFixed(1)} dB 波峰`;
      this.dom.valAdjustCm.textContent = '單聲道模式';
      this.dom.valAdjustCm.className = 'text-sm font-semibold text-amber-300';
    }

    if (spec.modes.length > 0) {
      this.dom.modesList.innerHTML = spec.modes
        .map(
          (m, idx) =>
            `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800/90 border border-slate-700 text-xs">
              <span class="text-amber-400 font-bold">#${idx + 1}</span>
              <span class="text-slate-100 font-mono">${m.freq.toFixed(1)} Hz</span>
              <span class="text-cyan-400 font-mono">${m.db.toFixed(0)}dB</span>
            </span>`
        )
        .join('');
    } else {
      this.dom.modesList.innerHTML = '<span class="text-xs text-slate-500">暫無顯著駐波峰值 (&gt;-75 dBFS)</span>';
    }
  }

  /* ==================== Canvas 1: Sweet-Spot Phase Compass ==================== */
  _sizeCanvas(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(200, Math.floor(rect.width * dpr));
    const h = Math.max(120, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return { ctx: canvas.getContext('2d'), w, h, dpr };
  }

  _drawCompassPlaceholder() {
    const { ctx, w, h, dpr } = this._sizeCanvas(this.dom.canvasCompass);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#64748b';
    ctx.font = `${12 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('請點擊頂部「一鍵啟動全部感應器」開啟聲學相位羅盤', w / 2, h / 2);
  }

  _drawCompass(isStereo, data) {
    const { ctx, w, h, dpr } = this._sizeCanvas(this.dom.canvasCompass);
    ctx.clearRect(0, 0, w, h);

    const cx = w * 0.5;
    const cy = h * 0.78;
    const r = Math.min(w * 0.38, h * 0.65);

    // Outer semicircle ticks (-90° to +90°)
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI, 0);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.65, Math.PI, 0);
    ctx.stroke();

    // Angle labels
    ctx.fillStyle = '#94a3b8';
    ctx.font = `${10 * dpr}px monospace`;
    ctx.textAlign = 'center';
    [-90, -45, 0, 45, 90].forEach((deg) => {
      const rad = ((deg - 90) * Math.PI) / 180;
      const x1 = cx + Math.cos(rad) * (r - 6 * dpr);
      const y1 = cy + Math.sin(rad) * (r - 6 * dpr);
      const x2 = cx + Math.cos(rad) * (r + 4 * dpr);
      const y2 = cy + Math.sin(rad) * (r + 4 * dpr);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = deg === 0 ? '#06B6D4' : 'rgba(148,163,184,0.4)';
      ctx.stroke();

      const lx = cx + Math.cos(rad) * (r + 14 * dpr);
      const ly = cy + Math.sin(rad) * (r + 14 * dpr);
      ctx.fillText(`${deg}°`, lx, ly + 3 * dpr);
    });

    if (isStereo) {
      // DoA Needle
      const clampedDeg = Math.max(-90, Math.min(90, data.doaDeg));
      const needleRad = ((clampedDeg - 90) * Math.PI) / 180;
      const nx = cx + Math.cos(needleRad) * (r * 0.92);
      const ny = cy + Math.sin(needleRad) * (r * 0.92);

      const isAligned = Math.abs(clampedDeg) < 4;
      ctx.strokeStyle = isAligned ? '#10B981' : '#F59E0B';
      ctx.lineWidth = 3 * dpr;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(nx, ny);
      ctx.stroke();

      ctx.fillStyle = isAligned ? '#10B981' : '#F59E0B';
      ctx.beginPath();
      ctx.arc(nx, ny, 5 * dpr, 0, Math.PI * 2);
      ctx.fill();

      // GCC-PHAT mini correlation curve at bottom
      if (data.curve && data.curve.length > 2) {
        const cw = w * 0.7;
        const ch = h * 0.16;
        const ox = (w - cw) / 2;
        const oy = h - ch - 4 * dpr;
        ctx.strokeStyle = '#06B6D4';
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        let maxAbs = 0.001;
        for (let i = 0; i < data.curve.length; i++) {
          maxAbs = Math.max(maxAbs, Math.abs(data.curve[i]));
        }
        for (let i = 0; i < data.curve.length; i++) {
          const px = ox + (i / (data.curve.length - 1)) * cw;
          const py = oy + ch * 0.5 - (data.curve[i] / maxAbs) * (ch * 0.45);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    } else {
      // Mono Coherence Arc
      const coh = Math.max(0, Math.min(1, data.coherence));
      ctx.strokeStyle = '#F59E0B';
      ctx.lineWidth = 6 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.82, Math.PI, Math.PI + Math.PI * coh);
      ctx.stroke();

      ctx.fillStyle = '#F8FAFC';
      ctx.font = `bold ${14 * dpr}px monospace`;
      ctx.fillText(`相干度 ${(coh * 100).toFixed(0)}%`, cx, cy - r * 0.25);
    }

    // Center pivot
    ctx.fillStyle = '#06B6D4';
    ctx.beginPath();
    ctx.arc(cx, cy, 4 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }

  /* ==================== Canvas 2: 20-250 Hz Spectrum & Waterfall ==================== */
  _drawWaterfall(spec) {
    const { ctx, w, h, dpr } = this._sizeCanvas(this.dom.canvasWaterfall);
    ctx.clearRect(0, 0, w, h);

    const specH = h * 0.45;
    const wfY = specH + 4 * dpr;
    const wfH = h - wfY;

    const minBin = Math.max(1, Math.floor(20 / spec.binHz));
    const maxBin = Math.min(spec.magDb.length - 1, Math.ceil(250 / spec.binHz));
    const count = maxBin - minBin + 1;
    if (count < 2) return;

    // Grid lines
    ctx.strokeStyle = 'rgba(148,163,184,0.15)';
    ctx.lineWidth = 1 * dpr;
    [50, 100, 150, 200].forEach((hz) => {
      const x = ((hz - 20) / 230) * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, specH);
      ctx.stroke();
      ctx.fillStyle = '#64748b';
      ctx.font = `${9 * dpr}px monospace`;
      ctx.fillText(`${hz}`, x + 2 * dpr, 10 * dpr);
    });

    // Peak hold line
    if (this.peakHoldDb && this.peakHoldDb.length === count) {
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.45)';
      ctx.lineWidth = 1.2 * dpr;
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const x = (i / (count - 1)) * w;
        const norm = Math.max(0, Math.min(1, (this.peakHoldDb[i] + 90) / 75));
        const y = specH - norm * (specH - 12 * dpr);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Live Spectrum Curve
    ctx.strokeStyle = '#06B6D4';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const db = spec.magDb[minBin + i];
      const x = (i / (count - 1)) * w;
      const norm = Math.max(0, Math.min(1, (db + 90) / 75));
      const y = specH - norm * (specH - 12 * dpr);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Waterfall rows
    const rowH = wfH / this.maxWaterfallRows;
    const colW = w / count;
    for (let r = 0; r < this.waterfallRows.length; r++) {
      const row = this.waterfallRows[r];
      const py = wfY + r * rowH;
      for (let c = 0; c < row.length; c++) {
        const norm = Math.max(0, Math.min(1, (row[c] + 85) / 65));
        ctx.fillStyle = this._heatColor(norm);
        ctx.fillRect(c * colW, py, colW + 0.8, rowH + 0.8);
      }
    }
  }

  _heatColor(t) {
    if (t < 0.25) {
      const k = t / 0.25;
      return `rgb(${Math.round(11 + k * 5)}, ${Math.round(15 + k * 45)}, ${Math.round(25 + k * 75)})`;
    } else if (t < 0.6) {
      const k = (t - 0.25) / 0.35;
      return `rgb(${Math.round(16 + k * 229)}, ${Math.round(60 + k * 98)}, ${Math.round(100 - k * 89)})`;
    } else {
      const k = (t - 0.6) / 0.4;
      return `rgb(${Math.round(245 + k * 10)}, ${Math.round(158 - k * 100)}, ${Math.round(11 + k * 57)})`;
    }
  }

  /* ==================== Module 2: Cabinet Resonance ==================== */
  _updateCabinetUI() {
    const score = this.sensors.dampingScore;
    this.dom.valDampingScore.textContent = `${score}`;
    this.dom.valRmsG.textContent = `${this.sensors.accelRmsG.toFixed(4)} G`;
    this.dom.valCabPeakHz.textContent = `${this.sensors.accelPeakHz.toFixed(1)} Hz`;
    this.dom.valAccelRate.textContent = `${this.sensors.accelSampleRate.toFixed(0)} Hz`;
    this.dom.valUlfDb.textContent = `${this.sensors.ulfEnvelopeDb.toFixed(1)} dB`;

    let badgeText = '極佳抑振';
    let badgeClass = 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
    if (score < 50) {
      badgeText = '嚴重箱體諧振';
      badgeClass = 'bg-rose-500/20 text-rose-300 border-rose-500/40';
    } else if (score < 75) {
      badgeText = '中度振動 (建議加裝角錐/避震墊)';
      badgeClass = 'bg-amber-500/20 text-amber-300 border-amber-500/40';
    } else if (score < 90) {
      badgeText = '良好抑振';
      badgeClass = 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40';
    }
    this.dom.dampingBadge.textContent = badgeText;
    this.dom.dampingBadge.className = `text-xs px-2.5 py-1 rounded-full border font-medium ${badgeClass}`;
  }

  _drawCabinetCanvas() {
    const { ctx, w, h, dpr } = this._sizeCanvas(this.dom.canvasCabinet);
    ctx.clearRect(0, 0, w, h);

    // Top half: 3-axis acceleration waveform
    const waveH = h * 0.48;
    const hist = this.sensors.accelHistory;
    if (hist.length > 2) {
      const drawAxis = (key, color, scale) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        for (let i = 0; i < hist.length; i++) {
          const x = (i / (hist.length - 1)) * w;
          const y = waveH * 0.5 - Math.max(-1, Math.min(1, hist[i][key] * scale)) * (waveH * 0.42);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      };
      drawAxis('x', 'rgba(6,182,212,0.7)', 1.5);
      drawAxis('y', 'rgba(16,185,129,0.7)', 1.5);
      drawAxis('z', '#F59E0B', 1.5);
    }

    // Bottom half: Cabinet FFT Resonance Spectrum
    const specY = waveH + 10 * dpr;
    const specH = h - specY;
    const spec = this.sensors.accelSpectrum;
    const barW = w / spec.length;
    for (let k = 1; k < spec.length; k++) {
      const norm = Math.min(1, spec[k] * 4.5);
      const bh = norm * (specH - 6 * dpr);
      ctx.fillStyle = norm > 0.65 ? '#EF4444' : '#06B6D4';
      ctx.fillRect(k * barW, h - bh, Math.max(1.5, barW - 1), bh);
    }

    ctx.fillStyle = '#94a3b8';
    ctx.font = `${10 * dpr}px monospace`;
    ctx.fillText('上方: X/Y/Z 振動波形 | 下方: 箱體 FFT 共鳴頻譜', 6 * dpr, specY + 10 * dpr);
  }

  /* ==================== Module 3: EMI / Magnetometer ==================== */
  _updateEmiUI() {
    const idx = this.sensors.emiIndex;
    this.dom.valEmiIndex.textContent = `${idx.toFixed(1)}`;

    if (this.sensors.magEngine === 'generic') {
      this.dom.valMagStatic.textContent = `${this.sensors.magStaticDev.toFixed(1)} µT`;
      this.dom.valMagJitter.textContent = `${this.sensors.magAcJitter.toFixed(2)} µT`;
    } else {
      this.dom.valMagStatic.textContent = `${this.sensors.magStaticDev.toFixed(1)}° 偏轉`;
      this.dom.valMagJitter.textContent = `${this.sensors.magAcJitter.toFixed(2)}°/s`;
    }

    if (this.sensors.emiStatus === 'danger') {
      this.dom.emiStatusBadge.textContent = '漏磁超標！請遠離變壓器/電源排插';
      this.dom.emiStatusBadge.className = 'text-xs px-2.5 py-1 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/50 animate-pulse';
    } else if (this.sensors.emiStatus === 'warn') {
      this.dom.emiStatusBadge.textContent = '偵測到中度磁場干擾';
      this.dom.emiStatusBadge.className = 'text-xs px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40';
    } else {
      this.dom.emiStatusBadge.textContent = '磁場環境安全';
      this.dom.emiStatusBadge.className = 'text-xs px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40';
    }
  }

  _drawEmiCanvas() {
    const { ctx, w, h, dpr } = this._sizeCanvas(this.dom.canvasEmi);
    ctx.clearRect(0, 0, w, h);

    const maxScale = Math.max(100, this.sensors.emiThreshold * 1.5);
    const threshY = h - (this.sensors.emiThreshold / maxScale) * (h - 12 * dpr);

    // Threshold line
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.7)';
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, threshY);
    ctx.lineTo(w, threshY);
    ctx.stroke();
    ctx.setLineDash([]);

    if (this.emiHistory.length > 1) {
      ctx.strokeStyle = this.sensors.emiStatus === 'danger' ? '#EF4444' : '#F59E0B';
      ctx.lineWidth = 2.5 * dpr;
      ctx.beginPath();
      for (let i = 0; i < this.emiHistory.length; i++) {
        const x = (i / (this.emiHistory.length - 1)) * w;
        const norm = Math.min(1, this.emiHistory[i] / maxScale);
        const y = h - norm * (h - 12 * dpr);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  /* ==================== Module 4: Snapshots & JSON Export ==================== */
  _loadSnapshots() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  _persistSnapshots() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.snapshots));
    } catch {
      // Ignore quota errors
    }
  }

  _saveCurrentSnapshot() {
    const label = (this.dom.inputSnapLabel.value || '').trim() || `調音紀錄 #${this.snapshots.length + 1}`;
    const snap = {
      id: `snap_${Date.now()}`,
      timestamp: new Date().toISOString(),
      label,
      mode: this.metrics.mode,
      deltaTMs: Number(this.metrics.deltaTMs.toFixed(3)),
      doaDeg: Number(this.metrics.doaDeg.toFixed(1)),
      adjustCm: Number(this.metrics.adjustCm.toFixed(1)),
      primaryModeHz: Number(this.metrics.primaryModeHz.toFixed(1)),
      primaryModeDb: Number(this.metrics.primaryModeDb.toFixed(1)),
      rt60: this.metrics.rt60 ? Number(this.metrics.rt60.toFixed(2)) : null,
      dampingScore: this.metrics.dampingScore,
      rmsG: Number(this.metrics.rmsG.toFixed(4)),
      cabinetPeakHz: Number(this.metrics.cabinetPeakHz.toFixed(1)),
      noiseFloorDb: Number(this.metrics.noiseFloorDb.toFixed(1)),
      emiIndex: Number(this.metrics.emiIndex.toFixed(1)),
      emiStatus: this.metrics.emiStatus,
    };

    this.snapshots.unshift(snap);
    this._persistSnapshots();
    this.dom.inputSnapLabel.value = '';

    if (this.snapshots.length >= 2) {
      this.compareAfterId = this.snapshots[0].id;
      this.compareBeforeId = this.snapshots[1].id;
    } else if (this.snapshots.length === 1) {
      this.compareBeforeId = this.snapshots[0].id;
      this.compareAfterId = this.snapshots[0].id;
    }

    this._renderSnapshotsUI();
    this._showBanner(`已儲存快照「${label}」`, 'emerald');
  }

  _renderSnapshotsUI() {
    const opts = this.snapshots
      .map((s) => `<option value="${s.id}">${s.label} (${new Date(s.timestamp).toLocaleTimeString()})</option>`)
      .join('');

    this.dom.selectBefore.innerHTML = opts || '<option value="">尚無紀錄</option>';
    this.dom.selectAfter.innerHTML = opts || '<option value="">尚無紀錄</option>';

    if (this.compareBeforeId && this.snapshots.some((s) => s.id === this.compareBeforeId)) {
      this.dom.selectBefore.value = this.compareBeforeId;
    } else if (this.snapshots.length > 1) {
      this.dom.selectBefore.value = this.snapshots[1].id;
      this.compareBeforeId = this.snapshots[1].id;
    }

    if (this.compareAfterId && this.snapshots.some((s) => s.id === this.compareAfterId)) {
      this.dom.selectAfter.value = this.compareAfterId;
    } else if (this.snapshots.length > 0) {
      this.dom.selectAfter.value = this.snapshots[0].id;
      this.compareAfterId = this.snapshots[0].id;
    }

    this._renderCompareCards();

    if (this.snapshots.length === 0) {
      this.dom.snapHistoryList.innerHTML = '<div class="text-xs text-slate-500 text-center py-4">尚無調音紀錄，請先測試並點擊「儲存當前快照」。</div>';
      return;
    }

    this.dom.snapHistoryList.innerHTML = this.snapshots
      .map(
        (s) => `
      <div class="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800 flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="text-sm font-semibold text-slate-100 truncate">${this._escapeHtml(s.label)}</div>
          <div class="text-[11px] text-slate-400 font-mono">
            抑振 ${s.dampingScore}分 | 駐波 ${s.primaryModeHz}Hz | 相位 ${s.deltaTMs}ms | EMI ${s.emiIndex}
          </div>
        </div>
        <button data-del-snap="${s.id}" class="text-xs px-2 py-1 rounded bg-slate-800 text-rose-400 hover:bg-rose-500/20">刪除</button>
      </div>`
      )
      .join('');

    this.dom.snapHistoryList.querySelectorAll('[data-del-snap]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-del-snap');
        this.snapshots = this.snapshots.filter((s) => s.id !== id);
        this._persistSnapshots();
        this._renderSnapshotsUI();
      });
    });
  }

  _renderCompareCards() {
    const before = this.snapshots.find((s) => s.id === this.compareBeforeId);
    const after = this.snapshots.find((s) => s.id === this.compareAfterId);
    if (!before || !after) {
      this.dom.compareGrid.innerHTML = '<div class="col-span-2 text-xs text-slate-500 text-center py-3">請儲存至少兩筆快照以進行「調整前 vs 調整後」對比</div>';
      return;
    }

    const row = (title, v1, v2, unit, higherBetter = true) => {
      const diff = v2 - v1;
      const sign = diff > 0 ? '+' : '';
      const isGood = higherBetter ? diff > 0 : diff < 0;
      const color = Math.abs(diff) < 0.001 ? 'text-slate-400' : isGood ? 'text-emerald-400' : 'text-rose-400';
      return `
        <div class="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800">
          <div class="text-[11px] text-slate-400 mb-1">${title}</div>
          <div class="flex items-baseline justify-between font-mono text-xs">
            <span class="text-slate-400">${v1}${unit}</span>
            <span class="text-slate-500">→</span>
            <span class="text-slate-100 font-bold text-sm">${v2}${unit}</span>
          </div>
          <div class="text-right font-mono text-[11px] ${color} mt-0.5">${sign}${diff.toFixed(2)}${unit}</div>
        </div>`;
    };

    this.dom.compareGrid.innerHTML =
      row('箱體抑振評分', before.dampingScore, after.dampingScore, ' 分', true) +
      row('相位時間差 Δt', Math.abs(before.deltaTMs), Math.abs(after.deltaTMs), ' ms', false) +
      row('駐波主峰能量', before.primaryModeDb, after.primaryModeDb, ' dB', false) +
      row('環境底噪', before.noiseFloorDb, after.noiseFloorDb, ' dB', false) +
      row('漏磁 EMI 指數', before.emiIndex, after.emiIndex, '', false) +
      row('殘響 RT60', before.rt60 || 0, after.rt60 || 0, ' s', false);
  }

  _exportJsonReport() {
    const payload = {
      app: 'AudioTune Fusion Web (Samsung Galaxy S24 Ultra Edition)',
      exportedAt: new Date().toISOString(),
      deviceSpecs: {
        micSpacingMeters: 0.162,
        userAgent: navigator.userAgent,
      },
      snapshots: this.snapshots,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audiotune-s24u-report-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  _escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new AudioTuneApp();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
});
