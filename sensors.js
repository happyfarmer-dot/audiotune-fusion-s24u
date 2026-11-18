/**
 * AudioTune Fusion Web - Hardware Sensor & Web Audio Fusion Manager
 * Designed for Samsung Galaxy S24 Ultra (Chrome / Samsung Internet)
 */

import {
  fftRadix2,
  createHannWindow,
  BiquadIIR,
  createPinkNoiseBuffer,
  createLogChirpBuffer,
} from './dsp.js';

export class SensorFusionManager {
  constructor() {
    // Wake Lock
    this.wakeLock = null;
    this.wakeLockActive = false;

    // Web Audio API
    this.audioCtx = null;
    this.micStream = null;
    this.micSource = null;
    this.splitter = null;
    this.analyserL = null;
    this.analyserR = null;
    this.isStereo = false;
    this.micActive = false;
    this.fftSize = 4096;
    this.bufL = new Float32Array(this.fftSize);
    this.bufR = new Float32Array(this.fftSize);
    this.hann4096 = createHannWindow(this.fftSize);

    // Ultra-low frequency (15-150 Hz) IIR filter for Module 2 acoustic-vibration fusion
    this.ulfHighpass = null;
    this.ulfLowpass = null;
    this.ulfEnvelopeDb = -80;

    // Signal Generator
    this.genGain = null;
    this.genSource = null;
    this.genMode = 'off'; // 'off' | 'pink' | 'chirp' | 'lf_sweep' | 'lf_manual'
    this.genVolume = 0.35;
    this.lfFreq = 50;
    this.lfSweepActive = false;
    this.lfSweepRaf = null;
    this.lfSweepStart = 0;

    // Module 2: DeviceMotion (Accelerometer)
    this.accelActive = false;
    this.accelSampleRate = 60;
    this.lastMotionTime = 0;
    this.accelUsingFallbackGravity = false;
    this.accelHpX = new BiquadIIR('highpass', 60, 2.0);
    this.accelHpY = new BiquadIIR('highpass', 60, 2.0);
    this.accelHpZ = new BiquadIIR('highpass', 60, 2.0);
    this.accelRingLen = 256; // Power of 2 for FFT
    this.accelRingZ = new Float32Array(this.accelRingLen);
    this.accelRingMag = new Float32Array(this.accelRingLen);
    this.accelRingIdx = 0;
    this.accelHann = createHannWindow(this.accelRingLen);
    this.accelHistory = []; // Recent {x, y, z, mag} for waveform
    this.accelRmsG = 0;
    this.accelPeakHz = 0;
    this.accelPeakAmp = 0;
    this.dampingScore = 100;
    this.accelSpectrum = new Float32Array(this.accelRingLen >> 1);

    // Module 3: Dual-Track Magnetometer
    this.magActive = false;
    this.magEngine = 'none'; // 'generic' | 'compass_fallback' | 'none'
    this.magSensor = null;
    this.magRaw = { x: 0, y: 0, z: 0, total: 0, alpha: 0 };
    this.magBaselineTotal = null;
    this.magBaselineAlpha = null;
    this.magWindow = []; // Sliding window of flux or alpha
    this.magStaticDev = 0; // µT or deg
    this.magAcJitter = 0; // µT std-dev or deg/s std-dev
    this.emiIndex = 0; // Unified 0-100+ EMI score
    this.emiStatus = 'safe'; // 'safe' | 'warn' | 'danger'
    this.emiThreshold = 45;
    this.hapticEnabled = true;
    this.lastVibrateTime = 0;

    // Callbacks
    this.onStatusChange = null;
    this.onSweepFreqUpdate = null;

    this._bindVisibilityWakeLock();
  }

  _notify() {
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange(this.getStatus());
    }
  }

  getStatus() {
    return {
      micActive: this.micActive,
      isStereo: this.isStereo,
      sampleRate: this.audioCtx ? this.audioCtx.sampleRate : 48000,
      accelActive: this.accelActive,
      accelSampleRate: this.accelSampleRate,
      magActive: this.magActive,
      magEngine: this.magEngine,
      wakeLockActive: this.wakeLockActive,
    };
  }

  /* ==================== 1. Screen Wake Lock ==================== */
  async requestWakeLock() {
    if (!('wakeLock' in navigator)) {
      this.wakeLockActive = false;
      return false;
    }
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLockActive = true;
      this.wakeLock.addEventListener('release', () => {
        this.wakeLockActive = false;
        this._notify();
      });
      this._notify();
      return true;
    } catch {
      this.wakeLockActive = false;
      this._notify();
      return false;
    }
  }

  _bindVisibilityWakeLock() {
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && (this.micActive || this.accelActive || this.magActive)) {
        await this.requestWakeLock();
      }
    });
  }

  /* ==================== 2. One-Click Activate All ==================== */
  async activateAll() {
    const results = {
      wakeLock: false,
      mic: false,
      accel: false,
      mag: false,
      errors: [],
    };

    // Must be called inside user gesture
    results.wakeLock = await this.requestWakeLock();

    try {
      results.mic = await this.initMicrophone();
    } catch (e) {
      results.errors.push(`麥克風: ${e.message || e}`);
    }

    try {
      results.accel = await this.initAccelerometer();
    } catch (e) {
      results.errors.push(`加速度計: ${e.message || e}`);
    }

    try {
      results.mag = await this.initMagnetometer();
    } catch (e) {
      results.errors.push(`磁力感應: ${e.message || e}`);
    }

    this._notify();
    return results;
  }

  /* ==================== 3. Web Audio API (Mic + ULF) ==================== */
  async ensureAudioContext() {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioContextClass({ latencyHint: 'interactive' });
    }
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }
    if (!this.genGain) {
      this.genGain = this.audioCtx.createGain();
      this.genGain.gain.value = this.genVolume;
      this.genGain.connect(this.audioCtx.destination);
    }
    if (!this.ulfHighpass) {
      this.ulfHighpass = new BiquadIIR('highpass', this.audioCtx.sampleRate, 15, 0.707);
      this.ulfLowpass = new BiquadIIR('lowpass', this.audioCtx.sampleRate, 150, 0.707);
    }
    return this.audioCtx;
  }

  async initMicrophone() {
    await this.ensureAudioContext();

    if (this.micActive && this.micStream) {
      return true;
    }

    const constraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
      },
    };

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch {
      // Fallback if strict constraints fail
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }

    const track = this.micStream.getAudioTracks()[0];
    const settings = track && typeof track.getSettings === 'function' ? track.getSettings() : {};

    this.micSource = this.audioCtx.createMediaStreamSource(this.micStream);
    const detectedChannels = settings.channelCount || this.micSource.channelCount || 1;
    this.isStereo = detectedChannels >= 2;

    this.analyserL = this.audioCtx.createAnalyser();
    this.analyserL.fftSize = this.fftSize;
    this.analyserL.smoothingTimeConstant = 0.0;

    if (this.isStereo) {
      this.splitter = this.audioCtx.createChannelSplitter(2);
      this.analyserR = this.audioCtx.createAnalyser();
      this.analyserR.fftSize = this.fftSize;
      this.analyserR.smoothingTimeConstant = 0.0;

      this.micSource.connect(this.splitter);
      this.splitter.connect(this.analyserL, 0);
      this.splitter.connect(this.analyserR, 1);
    } else {
      this.micSource.connect(this.analyserL);
    }

    this.micActive = true;
    this._notify();
    return true;
  }

  readAudioFrames() {
    if (!this.micActive || !this.analyserL) return null;

    this.analyserL.getFloatTimeDomainData(this.bufL);
    if (this.isStereo && this.analyserR) {
      this.analyserR.getFloatTimeDomainData(this.bufR);
      // Verify R is not identically zero (some Android devices report 2ch with silent 2nd ch)
      let rEnergy = 0;
      for (let i = 0; i < 256; i += 4) {
        rEnergy += Math.abs(this.bufR[i]);
      }
      if (rEnergy < 1e-8) {
        // Auto-demote to mono if right channel is hardware-muted
        this.isStereo = false;
        this._notify();
      }
    }

    // Update 15-150 Hz IIR ULF acoustic envelope for Module 2
    if (this.ulfHighpass && this.ulfLowpass) {
      let sumSq = 0;
      const step = 4; // Subsample 48kHz -> 12kHz envelope check for efficiency
      for (let i = 0; i < this.bufL.length; i += step) {
        const hp = this.ulfHighpass.processSample(this.bufL[i]);
        const bp = this.ulfLowpass.processSample(hp);
        sumSq += bp * bp;
      }
      const ulfRms = Math.sqrt(sumSq / (this.bufL.length / step));
      const db = ulfRms > 1e-7 ? 20 * Math.log10(ulfRms) : -90;
      this.ulfEnvelopeDb = this.ulfEnvelopeDb * 0.7 + db * 0.3;
    }

    return {
      left: this.bufL,
      right: this.isStereo ? this.bufR : null,
      isStereo: this.isStereo,
      sampleRate: this.audioCtx.sampleRate,
      ulfEnvelopeDb: this.ulfEnvelopeDb,
    };
  }

  /* ==================== 4. Signal Generator ==================== */
  async startGenerator(mode, manualFreq = 50) {
    await this.ensureAudioContext();
    this.stopGenerator(false);

    this.genMode = mode;
    this.lfFreq = manualFreq;

    if (mode === 'pink') {
      const buf = createPinkNoiseBuffer(this.audioCtx, 4.0);
      const src = this.audioCtx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(this.genGain);
      src.start();
      this.genSource = src;
    } else if (mode === 'chirp') {
      const buf = createLogChirpBuffer(this.audioCtx, 20, 8000, 3.5);
      const src = this.audioCtx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(this.genGain);
      src.start();
      this.genSource = src;
    } else if (mode === 'lf_sweep') {
      const osc = this.audioCtx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 30;
      osc.connect(this.genGain);
      osc.start();
      this.genSource = osc;
      this.lfSweepActive = true;
      this.lfSweepStart = performance.now();

      const tickSweep = () => {
        if (!this.lfSweepActive || !this.genSource) return;
        const elapsed = (performance.now() - this.lfSweepStart) / 1000;
        const period = 8.0; // 8-second smooth sweep 30 -> 200 Hz
        const t = (elapsed % period) / period;
        // Logarithmic sweep 30 Hz -> 200 Hz
        const freq = 30 * Math.pow(200 / 30, t);
        this.lfFreq = freq;
        this.genSource.frequency.setTargetAtTime(freq, this.audioCtx.currentTime, 0.015);
        if (typeof this.onSweepFreqUpdate === 'function') {
          this.onSweepFreqUpdate(freq);
        }
        this.lfSweepRaf = requestAnimationFrame(tickSweep);
      };
      this.lfSweepRaf = requestAnimationFrame(tickSweep);
    } else if (mode === 'lf_manual') {
      const osc = this.audioCtx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = manualFreq;
      osc.connect(this.genGain);
      osc.start();
      this.genSource = osc;
    }
  }

  setGeneratorVolume(vol) {
    this.genVolume = Math.max(0, Math.min(1, vol));
    if (this.genGain && this.audioCtx) {
      this.genGain.gain.setTargetAtTime(this.genVolume, this.audioCtx.currentTime, 0.02);
    }
  }

  setManualFrequency(freq) {
    this.lfFreq = Math.max(20, Math.min(250, freq));
    if (this.genMode === 'lf_manual' && this.genSource && this.audioCtx) {
      this.genSource.frequency.setTargetAtTime(this.lfFreq, this.audioCtx.currentTime, 0.015);
    }
  }

  stopGenerator(resetMode = true) {
    this.lfSweepActive = false;
    if (this.lfSweepRaf) {
      cancelAnimationFrame(this.lfSweepRaf);
      this.lfSweepRaf = null;
    }
    if (this.genSource) {
      try {
        this.genSource.stop();
        this.genSource.disconnect();
      } catch {
        // Ignore already stopped
      }
      this.genSource = null;
    }
    if (resetMode) {
      this.genMode = 'off';
    }
  }

  /* ==================== 5. DeviceMotion (Module 2) ==================== */
  async initAccelerometer() {
    if (this.accelActive) return true;

    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const perm = await DeviceMotionEvent.requestPermission();
      if (perm !== 'granted') {
        throw new Error('動態感應器權限被拒絕');
      }
    }

    if (!('ondevicemotion' in window)) {
      throw new Error('此瀏覽器不支援 DeviceMotion API');
    }

    this._onDeviceMotion = (e) => this._handleDeviceMotion(e);
    window.addEventListener('devicemotion', this._onDeviceMotion, { passive: true });
    this.accelActive = true;
    this._notify();
    return true;
  }

  _handleDeviceMotion(event) {
    const now = performance.now();
    if (this.lastMotionTime > 0) {
      const dtMs = now - this.lastMotionTime;
      if (dtMs > 1 && dtMs < 500) {
        const instRate = 1000 / dtMs;
        this.accelSampleRate = this.accelSampleRate * 0.9 + instRate * 0.1;
      }
    } else if (event.interval && event.interval > 0) {
      // Chrome reports interval in ms; Safari reports in s
      const intervalMs = event.interval < 1 ? event.interval * 1000 : event.interval;
      this.accelSampleRate = Math.min(400, Math.max(10, 1000 / intervalMs));
    }
    this.lastMotionTime = now;

    let ax = 0,
      ay = 0,
      az = 0;
    const acc = event.acceleration;
    if (acc && acc.x !== null && acc.y !== null && acc.z !== null) {
      ax = acc.x;
      ay = acc.y;
      az = acc.z;
      this.accelUsingFallbackGravity = false;
    } else if (event.accelerationIncludingGravity) {
      this.accelUsingFallbackGravity = true;
      const g = event.accelerationIncludingGravity;
      ax = this.accelHpX.processSample(g.x || 0);
      ay = this.accelHpY.processSample(g.y || 0);
      az = this.accelHpZ.processSample(g.z || 0);
    }

    const mag = Math.sqrt(ax * ax + ay * ay + az * az);

    // Push into FFT ring buffer
    this.accelRingZ[this.accelRingIdx] = az;
    this.accelRingMag[this.accelRingIdx] = mag;
    this.accelRingIdx = (this.accelRingIdx + 1) % this.accelRingLen;

    // Push into display history
    this.accelHistory.push({ x: ax, y: ay, z: az, mag });
    if (this.accelHistory.length > 180) {
      this.accelHistory.shift();
    }

    // Recompute RMS G & FFT every 8 samples
    if (this.accelRingIdx % 8 === 0) {
      this._analyzeCabinetResonance();
    }
  }

  _analyzeCabinetResonance() {
    const N = this.accelRingLen;
    let sumSq = 0;
    const re = new Float64Array(N);
    const im = new Float64Array(N);

    for (let i = 0; i < N; i++) {
      const idx = (this.accelRingIdx + i) % N;
      const m = this.accelRingMag[idx];
      sumSq += m * m;
      re[i] = this.accelRingZ[idx] * this.accelHann[i];
    }

    const rmsMs2 = Math.sqrt(sumSq / N);
    this.accelRmsG = rmsMs2 / 9.80665;

    fftRadix2(re, im, false);

    const halfN = N >> 1;
    const binHz = this.accelSampleRate / N;
    let peakHz = 0;
    let peakAmp = 0;

    for (let k = 1; k < halfN; k++) {
      const amp = (Math.sqrt(re[k] * re[k] + im[k] * im[k]) * 4.0) / N;
      this.accelSpectrum[k] = amp;
      const freq = k * binHz;
      if (freq >= 5 && amp > peakAmp) {
        peakAmp = amp;
        peakHz = freq;
      }
    }

    this.accelPeakHz = peakHz;
    this.accelPeakAmp = peakAmp;

    // Damping Score (0-100):
    // 0.002 G = near-perfect (~98), 0.05 G = moderate (~65), 0.15+ G = poor (<20)
    // Also factor in acoustic-coupled resonance if ULF mic is loud (> -35 dBFS)
    const gPenalty = Math.min(85, this.accelRmsG * 580);
    const peakPenalty = Math.min(15, peakAmp * 120);
    this.dampingScore = Math.max(0, Math.min(100, Math.round(100 - gPenalty - peakPenalty)));
  }

  /* ==================== 6. Dual-Track Magnetometer (Module 3) ==================== */
  async initMagnetometer() {
    if (this.magActive) return true;

    // Track A: Generic Sensor API ('Magnetometer' in window)
    if ('Magnetometer' in window) {
      try {
        if (navigator.permissions && navigator.permissions.query) {
          const status = await navigator.permissions.query({ name: 'magnetometer' });
          if (status.state === 'denied') {
            throw new Error('Magnetometer permission denied');
          }
        }
        const sensor = new window.Magnetometer({ frequency: 60 });
        sensor.addEventListener('reading', () => {
          this._handleGenericMag(sensor.x, sensor.y, sensor.z);
        });
        sensor.addEventListener('error', () => {
          // Seamless fallback if hardware/flag rejects Generic Magnetometer
          this._startCompassFallback();
        });
        sensor.start();
        this.magSensor = sensor;
        this.magEngine = 'generic';
        this.magActive = true;
        this._notify();
        return true;
      } catch {
        // Fall through to Track B
      }
    }

    // Track B: Automatic Fallback (deviceorientationabsolute / deviceorientation)
    return this._startCompassFallback();
  }

  async _startCompassFallback() {
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function'
    ) {
      try {
        await DeviceOrientationEvent.requestPermission();
      } catch {
        // Continue to try listener
      }
    }

    this.magEngine = 'compass_fallback';
    this._onOrientation = (e) => this._handleCompassOrientation(e);

    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', this._onOrientation, { passive: true });
    } else {
      window.addEventListener('deviceorientation', this._onOrientation, { passive: true });
    }

    this.magActive = true;
    this._notify();
    return true;
  }

  _handleGenericMag(x, y, z) {
    const total = Math.sqrt(x * x + y * y + z * z);
    this.magRaw.x = x;
    this.magRaw.y = y;
    this.magRaw.z = z;
    this.magRaw.total = total;

    if (this.magBaselineTotal === null) {
      this.magBaselineTotal = total;
    }

    this.magWindow.push(total);
    if (this.magWindow.length > 36) {
      this.magWindow.shift();
    }

    // Static magnetic deviation (µT) from baseline
    this.magStaticDev = Math.abs(total - this.magBaselineTotal);

    // AC magnetic jitter (std-dev of high-frequency flux)
    let mean = 0;
    for (let i = 0; i < this.magWindow.length; i++) mean += this.magWindow[i];
    mean /= this.magWindow.length;

    let varSum = 0;
    for (let i = 0; i < this.magWindow.length; i++) {
      const d = this.magWindow[i] - mean;
      varSum += d * d;
    }
    this.magAcJitter = Math.sqrt(varSum / this.magWindow.length);

    // Unified EMI Index: Earth field is ~45 µT; transformer leak easily adds +20..+150 µT & AC jitter
    const rawEmi = this.magStaticDev * 1.1 + this.magAcJitter * 6.5;
    this.emiIndex = this.emiIndex * 0.65 + rawEmi * 0.35;
    this._evaluateEmiStatus();
  }

  _handleCompassOrientation(event) {
    const alpha =
      typeof event.webkitCompassHeading === 'number'
        ? event.webkitCompassHeading
        : event.alpha !== null
          ? event.alpha
          : null;

    if (alpha === null) return;
    this.magRaw.alpha = alpha;

    if (this.magBaselineAlpha === null) {
      this.magBaselineAlpha = alpha;
    }

    // Circular shortest-angle difference (-180 to +180)
    const circularDiff = (a, b) => {
      let d = ((a - b + 540) % 360) - 180;
      return d;
    };

    this.magStaticDev = Math.abs(circularDiff(alpha, this.magBaselineAlpha));

    this.magWindow.push(alpha);
    if (this.magWindow.length > 30) {
      this.magWindow.shift();
    }

    // High-frequency angular velocity jitter std-dev (between consecutive samples)
    if (this.magWindow.length >= 4) {
      const diffs = [];
      let sum = 0;
      for (let i = 1; i < this.magWindow.length; i++) {
        const d = Math.abs(circularDiff(this.magWindow[i], this.magWindow[i - 1]));
        diffs.push(d);
        sum += d;
      }
      const mean = sum / diffs.length;
      let varSum = 0;
      for (let i = 0; i < diffs.length; i++) {
        const dd = diffs[i] - mean;
        varSum += dd * dd;
      }
      this.magAcJitter = Math.sqrt(varSum / diffs.length);
    }

    // Unified EMI Index for compass fallback
    const rawEmi = this.magStaticDev * 1.25 + this.magAcJitter * 12.0;
    this.emiIndex = this.emiIndex * 0.65 + rawEmi * 0.35;
    this._evaluateEmiStatus();
  }

  _evaluateEmiStatus() {
    if (this.emiIndex >= this.emiThreshold) {
      this.emiStatus = 'danger';
      const now = performance.now();
      if (this.hapticEnabled && now - this.lastVibrateTime > 900 && 'vibrate' in navigator) {
        try {
          navigator.vibrate([80, 40, 80]);
          this.lastVibrateTime = now;
        } catch {
          // Ignore if vibration blocked
        }
      }
    } else if (this.emiIndex >= this.emiThreshold * 0.55) {
      this.emiStatus = 'warn';
    } else {
      this.emiStatus = 'safe';
    }
  }

  calibrateMagnetometer() {
    if (this.magEngine === 'generic') {
      this.magBaselineTotal = this.magRaw.total;
    } else if (this.magEngine === 'compass_fallback') {
      this.magBaselineAlpha = this.magRaw.alpha;
    }
    this.magWindow = [];
    this.emiIndex = 0;
    this.emiStatus = 'safe';
  }
}
