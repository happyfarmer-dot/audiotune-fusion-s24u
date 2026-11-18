/**
 * AudioTune Fusion Web - Pure ES6 DSP Engine
 * Implements:
 * 1. Radix-2 Cooley-Tukey FFT & IFFT (4096-pt default, arbitrary power-of-2)
 * 2. Hann / Blackman-Harris windowing & parabolic peak interpolation
 * 3. GCC-PHAT (Generalized Cross-Correlation with Phase Transform) for DoA & Δt
 * 4. 2nd-Order IIR Butterworth Biquad Filters (Bandpass / Lowpass / Highpass)
 * 5. Low-frequency (20-250 Hz) standing wave mode detector
 * 6. Schroeder backward integration RT60 reverberation time estimator
 * 7. Mono impulse/phase coherence & Pink Noise / Log Chirp generators
 */

export const SPEED_OF_SOUND = 343.0; // m/s at ~20°C
export const S24U_MIC_SPACING = 0.162; // meters (top & bottom mic spacing on Galaxy S24 Ultra)

/**
 * In-place Radix-2 Cooley-Tukey FFT / IFFT
 * @param {Float64Array|Float32Array} re - Real part (modified in-place), length must be power of 2
 * @param {Float64Array|Float32Array} im - Imaginary part (modified in-place), length must be power of 2
 * @param {boolean} inverse - true for IFFT, false for forward FFT
 */
export function fftRadix2(re, im, inverse = false) {
  const n = re.length;
  if (n === 0 || (n & (n - 1)) !== 0) {
    throw new Error(`FFT length must be a power of 2, got ${n}`);
  }

  // Bit-reversal permutation
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  // Butterfly stages
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const angleStep = (sign * 2 * Math.PI) / size;
    const wStepRe = Math.cos(angleStep);
    const wStepIm = Math.sin(angleStep);

    for (let start = 0; start < n; start += size) {
      let wRe = 1.0;
      let wIm = 0.0;
      for (let k = 0; k < half; k++) {
        const evenIdx = start + k;
        const oddIdx = evenIdx + half;

        const oddRe = re[oddIdx];
        const oddIm = im[oddIdx];

        const tRe = wRe * oddRe - wIm * oddIm;
        const tIm = wRe * oddIm + wIm * oddRe;

        re[oddIdx] = re[evenIdx] - tRe;
        im[oddIdx] = im[evenIdx] - tIm;
        re[evenIdx] += tRe;
        im[evenIdx] += tIm;

        const nextWRe = wRe * wStepRe - wIm * wStepIm;
        wIm = wRe * wStepIm + wIm * wStepRe;
        wRe = nextWRe;
      }
    }
  }

  if (inverse) {
    const invN = 1.0 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= invN;
      im[i] *= invN;
    }
  }
}

/**
 * Precompute Hann window coefficients
 */
export function createHannWindow(length) {
  const win = new Float32Array(length);
  const factor = (2 * Math.PI) / (length - 1);
  for (let i = 0; i < length; i++) {
    win[i] = 0.5 * (1 - Math.cos(factor * i));
  }
  return win;
}

/**
 * 2nd-Order IIR Butterworth Biquad Filter (Direct Form II Transposed)
 */
export class BiquadIIR {
  constructor(type, sampleRate, freq, q = 0.70710678) {
    this.b0 = 1;
    this.b1 = 0;
    this.b2 = 0;
    this.a1 = 0;
    this.a2 = 0;
    this.z1 = 0;
    this.z2 = 0;
    this.configure(type, sampleRate, freq, q);
  }

  configure(type, sampleRate, freq, q = 0.70710678) {
    const clampedFreq = Math.max(1, Math.min(freq, sampleRate * 0.49));
    const omega = (2 * Math.PI * clampedFreq) / sampleRate;
    const sinW = Math.sin(omega);
    const cosW = Math.cos(omega);
    const alpha = sinW / (2 * q);

    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'lowpass':
        b0 = (1 - cosW) / 2;
        b1 = 1 - cosW;
        b2 = (1 - cosW) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cosW;
        a2 = 1 - alpha;
        break;
      case 'highpass':
        b0 = (1 + cosW) / 2;
        b1 = -(1 + cosW);
        b2 = (1 + cosW) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cosW;
        a2 = 1 - alpha;
        break;
      case 'bandpass':
      default:
        b0 = alpha;
        b1 = 0;
        b2 = -alpha;
        a0 = 1 + alpha;
        a1 = -2 * cosW;
        a2 = 1 - alpha;
        break;
    }

    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  reset() {
    this.z1 = 0;
    this.z2 = 0;
  }

  processSample(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  processBuffer(input, output = null) {
    const out = output || new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      out[i] = this.processSample(input[i]);
    }
    return out;
  }
}

/**
 * Compute GCC-PHAT between two 4096-sample frames (Left/Top & Right/Bottom)
 * Returns { deltaTMs, doaDeg, adjustCm, confidence, peakCorr, curve }
 */
export function computeGCCPHAT(ch1, ch2, sampleRate, hannWindow, micSpacing = S24U_MIC_SPACING) {
  const N = ch1.length;
  const re1 = new Float64Array(N);
  const im1 = new Float64Array(N);
  const re2 = new Float64Array(N);
  const im2 = new Float64Array(N);

  let e1 = 0;
  let e2 = 0;
  for (let i = 0; i < N; i++) {
    const w = hannWindow ? hannWindow[i] : 1.0;
    const s1 = ch1[i] * w;
    const s2 = ch2[i] * w;
    re1[i] = s1;
    re2[i] = s2;
    e1 += s1 * s1;
    e2 += s2 * s2;
  }

  const rms = Math.sqrt((e1 + e2) / (2 * N));
  if (rms < 1e-5) {
    return {
      deltaTMs: 0,
      doaDeg: 0,
      adjustCm: 0,
      confidence: 0,
      peakCorr: 0,
      curve: new Float32Array(65),
    };
  }

  fftRadix2(re1, im1, false);
  fftRadix2(re2, im2, false);

  // Cross-power spectrum G = X1 * conj(X2), PHAT weighted: G / (|G| + eps)
  // Band-limit to 80 Hz - 12000 Hz to suppress DC & ultrasonic noise
  const binHz = sampleRate / N;
  const minBin = Math.max(1, Math.floor(80 / binHz));
  const maxBin = Math.min(N >> 1, Math.ceil(12000 / binHz));

  const gRe = new Float64Array(N);
  const gIm = new Float64Array(N);
  let maxCrossMag = 0;
  for (let k = minBin; k <= maxBin; k++) {
    const r = re1[k] * re2[k] + im1[k] * im2[k];
    const im = im1[k] * re2[k] - re1[k] * im2[k];
    const mag = Math.sqrt(r * r + im * im);
    if (mag > maxCrossMag) maxCrossMag = mag;
    gRe[k] = r;
    gIm[k] = im;
  }

  const eps = Math.max(1e-9, maxCrossMag * 1e-3);

  for (let k = minBin; k <= maxBin; k++) {
    const r = gRe[k];
    const im = gIm[k];
    const mag = Math.sqrt(r * r + im * im) + eps;
    const wr = r / mag;
    const wi = im / mag;
    gRe[k] = wr;
    gIm[k] = wi;
    // Conjugate symmetry for real IFFT
    if (k > 0 && k < N >> 1) {
      gRe[N - k] = wr;
      gIm[N - k] = -wi;
    }
  }

  fftRadix2(gRe, gIm, true);

  // Search lag window: physical max lag for micSpacing + room reflection margin (±48 samples ~ ±1ms)
  const physicalMaxLag = Math.ceil((micSpacing / SPEED_OF_SOUND) * sampleRate);
  const searchRadius = Math.min(Math.max(physicalMaxLag + 8, 32), (N >> 2) - 1);

  let bestLag = 0;
  let bestVal = -Infinity;
  let sumSq = 0;
  const curveLen = searchRadius * 2 + 1;
  const curve = new Float32Array(curveLen);

  for (let lag = -searchRadius; lag <= searchRadius; lag++) {
    const idx = lag >= 0 ? lag : N + lag;
    const val = gRe[idx];
    curve[lag + searchRadius] = val;
    sumSq += val * val;
    if (val > bestVal) {
      bestVal = val;
      bestLag = lag;
    }
  }

  // Parabolic interpolation for sub-sample precision
  let fractionalLag = bestLag;
  if (bestLag > -searchRadius && bestLag < searchRadius) {
    const yL = curve[bestLag - 1 + searchRadius];
    const yC = curve[bestLag + searchRadius];
    const yR = curve[bestLag + 1 + searchRadius];
    const denom = 2 * (yL - 2 * yC + yR);
    if (Math.abs(denom) > 1e-12) {
      const shift = (yL - yR) / denom;
      if (Math.abs(shift) <= 1.0) {
        fractionalLag += shift;
      }
    }
  }

  const deltaTSec = fractionalLag / sampleRate;
  const deltaTMs = deltaTSec * 1000.0;

  // DoA angle: sin(theta) = (deltaT * c) / micSpacing
  const sinTheta = Math.max(-1.0, Math.min(1.0, (deltaTSec * SPEED_OF_SOUND) / micSpacing));
  const doaDeg = (Math.asin(sinTheta) * 180.0) / Math.PI;

  // Suggested physical speaker distance micro-adjustment in cm
  const adjustCm = deltaTSec * SPEED_OF_SOUND * 100.0;

  // Peak-to-RMS confidence metric (0 to 1)
  const curveRms = Math.sqrt(sumSq / curveLen) + 1e-9;
  const confidence = Math.max(0, Math.min(1, (bestVal / curveRms - 1.5) / 5.0));

  return {
    deltaTMs,
    doaDeg,
    adjustCm,
    confidence,
    peakCorr: bestVal,
    curve,
  };
}

/**
 * Mono Fallback: Impulse Phase Alignment & Autocorrelation Coherence
 * Used when browser returns 1 channel instead of 2-channel stereo
 */
export function computeMonoPhaseCoherence(samples, sampleRate, hannWindow) {
  const N = samples.length;
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < N; i++) {
    const s = samples[i];
    const absS = Math.abs(s);
    if (absS > peak) peak = absS;
    sumSq += s * s;
    re[i] = s * (hannWindow ? hannWindow[i] : 1.0);
  }

  const rms = Math.sqrt(sumSq / N);
  const crestFactorDb = rms > 1e-7 ? 20 * Math.log10(peak / rms) : 0;

  fftRadix2(re, im, false);

  // Compute phase coherence across low-mid band (40 Hz - 500 Hz)
  const binHz = sampleRate / N;
  const startBin = Math.max(2, Math.floor(40 / binHz));
  const endBin = Math.min((N >> 1) - 1, Math.ceil(500 / binHz));

  let cosSum = 0;
  let sinSum = 0;
  let count = 0;
  for (let k = startBin; k <= endBin; k++) {
    const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    if (mag > 1e-6) {
      const phaseDiff = Math.atan2(im[k], re[k]) - Math.atan2(im[k - 1], re[k - 1]);
      cosSum += Math.cos(phaseDiff);
      sinSum += Math.sin(phaseDiff);
      count++;
    }
  }

  const coherence = count > 0 ? Math.sqrt(cosSum * cosSum + sinSum * sinSum) / count : 0;
  // Map coherence to an equivalent phase alignment score (0-100%) and pseudo-phase angle
  const phaseAngleDeg = count > 0 ? (Math.atan2(sinSum, cosSum) * 180) / Math.PI : 0;

  return {
    rms,
    crestFactorDb,
    coherence,
    phaseAngleDeg,
  };
}

/**
 * Compute magnitude spectrum (dBFS) and extract 20-250 Hz standing wave peaks
 * Uses parabolic interpolation for ~1 Hz peak frequency precision even with 4096-pt FFT
 */
export function analyzeSpectrumAndModes(samples, sampleRate, hannWindow) {
  const N = samples.length;
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  let sumSq = 0;
  for (let i = 0; i < N; i++) {
    const s = samples[i];
    sumSq += s * s;
    re[i] = s * (hannWindow ? hannWindow[i] : 1.0);
  }

  const rms = Math.sqrt(sumSq / N);
  const dbfs = rms > 1e-7 ? 20 * Math.log10(rms) : -100;

  fftRadix2(re, im, false);

  const halfN = N >> 1;
  const binHz = sampleRate / N;
  const normFactor = 2.0 / (N * 0.5); // Hann coherent gain = 0.5

  const magDb = new Float32Array(halfN);
  for (let k = 0; k < halfN; k++) {
    const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * normFactor;
    magDb[k] = mag > 1e-7 ? Math.max(-100, 20 * Math.log10(mag)) : -100;
  }

  // Extract 20 - 250 Hz standing wave peaks
  const minBin = Math.max(1, Math.floor(20 / binHz));
  const maxBin = Math.min(halfN - 2, Math.ceil(250 / binHz));

  const peaks = [];
  for (let k = minBin; k <= maxBin; k++) {
    if (magDb[k] > magDb[k - 1] && magDb[k] > magDb[k + 1] && magDb[k] > -75) {
      // Parabolic interpolation
      const yL = magDb[k - 1];
      const yC = magDb[k];
      const yR = magDb[k + 1];
      const denom = 2 * (yL - 2 * yC + yR);
      let shift = 0;
      if (Math.abs(denom) > 1e-9) {
        shift = Math.max(-0.5, Math.min(0.5, (yL - yR) / denom));
      }
      const freq = (k + shift) * binHz;
      if (freq >= 20 && freq <= 250) {
        peaks.push({
          freq,
          db: yC - 0.25 * (yL - yR) * shift,
          bin: k,
        });
      }
    }
  }

  peaks.sort((a, b) => b.db - a.db);

  return {
    dbfs,
    binHz,
    magDb,
    modes: peaks.slice(0, 3),
  };
}

/**
 * Estimate Room Reverberation Time (RT60) from an energy decay time-series (in dB)
 * using linear regression on the T20 (-5 dB to -25 dB) or T15 (-5 dB to -20 dB) decay slope
 * @param {number[]} decayDbSeries - Array of RMS dB values sampled at `stepSec` intervals after peak
 * @param {number} stepSec - Time step between samples in seconds
 * @returns {{ rt60: number, valid: boolean, dropDb: number }}
 */
export function estimateRT60(decayDbSeries, stepSec) {
  if (!decayDbSeries || decayDbSeries.length < 6) {
    return { rt60: 0, valid: false, dropDb: 0 };
  }

  const peakDb = decayDbSeries[0];
  const minDb = Math.min(...decayDbSeries);
  const dropDb = peakDb - minDb;

  if (dropDb < 12) {
    return { rt60: 0, valid: false, dropDb };
  }

  // Collect points between -3 dB and -23 dB below peak (or down to noise floor + 3 dB)
  const upperThresh = peakDb - 3.0;
  const lowerThresh = Math.max(peakDb - 25.0, minDb + 3.0);

  const xs = [];
  const ys = [];
  for (let i = 0; i < decayDbSeries.length; i++) {
    const db = decayDbSeries[i];
    if (db <= upperThresh && db >= lowerThresh) {
      xs.push(i * stepSec);
      ys.push(db);
    }
    if (db < lowerThresh) break;
  }

  if (xs.length < 3) {
    return { rt60: 0, valid: false, dropDb };
  }

  // Least-squares linear regression: y = slope * x + intercept
  const n = xs.length;
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
    sumXY += xs[i] * ys[i];
    sumXX += xs[i] * xs[i];
  }
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-12) {
    return { rt60: 0, valid: false, dropDb };
  }

  const slope = (n * sumXY - sumX * sumY) / denom; // dB per second (negative)
  if (slope >= -2.0) {
    return { rt60: 0, valid: false, dropDb };
  }

  const rt60 = Math.max(0.08, Math.min(5.0, -60.0 / slope));
  return { rt60, valid: true, dropDb };
}

/**
 * Generate Paul Kellet's Pink Noise AudioBuffer (-3dB/octave)
 */
export function createPinkNoiseBuffer(audioCtx, durationSec = 4.0) {
  const sampleRate = audioCtx.sampleRate;
  const length = Math.floor(sampleRate * durationSec);
  const buffer = audioCtx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);

  let b0 = 0,
    b1 = 0,
    b2 = 0,
    b3 = 0,
    b4 = 0,
    b5 = 0,
    b6 = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.0168980;
    const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;
    data[i] = pink * 0.11; // Normalized to prevent clipping
  }

  // Smooth crossfade at loop boundary (last 20ms -> first 20ms)
  const fadeSamples = Math.min(Math.floor(sampleRate * 0.02), length >> 2);
  for (let i = 0; i < fadeSamples; i++) {
    const t = i / fadeSamples;
    data[i] = data[i] * t + data[length - fadeSamples + i] * (1 - t);
  }
  return buffer;
}

/**
 * Generate 20 Hz - 8,000 Hz Logarithmic Chirp AudioBuffer
 */
export function createLogChirpBuffer(audioCtx, f0 = 20, f1 = 8000, durationSec = 3.5) {
  const sampleRate = audioCtx.sampleRate;
  const length = Math.floor(sampleRate * durationSec);
  const buffer = audioCtx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);

  const lnRatio = Math.log(f1 / f0);
  const k = (2 * Math.PI * f0 * durationSec) / lnRatio;
  const fadeLen = Math.floor(sampleRate * 0.03); // 30ms fade in/out

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const phase = k * (Math.pow(f1 / f0, t / durationSec) - 1);
    let env = 0.85;
    if (i < fadeLen) {
      env *= 0.5 * (1 - Math.cos((Math.PI * i) / fadeLen));
    } else if (i > length - fadeLen) {
      env *= 0.5 * (1 - Math.cos((Math.PI * (length - i)) / fadeLen));
    }
    data[i] = Math.sin(phase) * env;
  }
  return buffer;
}
