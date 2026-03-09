"use client";

import { useCallback, useRef, useEffect } from 'react';
import {
  uploadAudio,
  generateFrames,
  LipsyncInfoEvent,
  LipsyncFrameEvent,
  LipsyncCompleteEvent,
} from '@/services/lipsync';
import { useAvatarStore } from '@/store/avatarStore';

/** 预生成的数据 */
export interface PreparedLipsyncData {
  frames: string[];           // base64 帧数据
  bitmaps?: ImageBitmap[];    // 预解码的帧（可选，播放时生成）
  audioBytes: Uint8Array;     // 原始音频
  totalFrames: number;
  fps: number;
  width: number;
  height: number;
}

/** 播放回调 */
export interface LipsyncPlayerCallbacks {
  onPlayStart?: () => void;
  onPlayEnd?: () => void;
  onError?: (error: Error) => void;
}

/** 播放器返回值 */
export interface LipsyncPlayerResult {
  /** 预生成帧（可以并行调用多个） */
  prepare: (faceFileId: string, audioBytes: Uint8Array, signal?: AbortSignal) => Promise<PreparedLipsyncData>;
  /** 播放预生成的数据 */
  playPrepared: (data: PreparedLipsyncData, callbacks?: LipsyncPlayerCallbacks) => Promise<void>;
  /** 帧流播放：边接收 SSE 帧边解码边播放，无需等待全部帧 */
  playStream: (faceFileId: string, audioBytes: Uint8Array, callbacks?: LipsyncPlayerCallbacks, signal?: AbortSignal) => Promise<void>;
  /** 停止当前播放 */
  stop: (options?: { preserveCanvas?: boolean }) => void;
  /** 是否正在播放 */
  isPlaying: () => boolean;
}

/** 获取 lip-sync canvas 元素 */
function getLipsyncCanvas(): HTMLCanvasElement | null {
  return document.getElementById('lipsync-canvas') as HTMLCanvasElement | null;
}

/** Wav2Lip 生成参数 */
const LIPSYNC_GENERATE_OPTIONS = {
  batchSize: 32,   
  outputFps: 59,    
  jpegQuality: 85,  
  resizeFactor: 0.5,  
} as const;

/**
 * Lip-sync 播放器 Hook
 * 支持并行预生成 + 顺序播放，以及帧流实时播放
 */
export function useLipsyncPlayer(): LipsyncPlayerResult {
  const { setLipsyncMode } = useAvatarStore();

  // Canvas context ref
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  // 播放状态
  const isPlayingRef = useRef(false);
  const currentFrameRef = useRef(0);

  // 音频相关
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const audioStartTimeRef = useRef<number>(0);

  // 渲染相关
  const animationFrameIdRef = useRef<number | null>(null);
  const currentDataRef = useRef<PreparedLipsyncData | null>(null);
  const bitmapsRef = useRef<ImageBitmap[]>([]);

  // 流式播放的 bitmap 数组（允许 null 占位表示尚未解码）
  const streamBitmapsRef = useRef<(ImageBitmap | null)[]>([]);

  // 播放完成回调
  const onPlayEndRef = useRef<(() => void) | null>(null);

  /**
   * 绘制 ImageBitmap 到 Canvas（同步，无闪烁）
   */
  const drawBitmap = useCallback((bitmap: ImageBitmap) => {
    const ctx = ctxRef.current;
    const canvas = getLipsyncCanvas();
    if (!ctx || !canvas) return;

    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  }, []);

  /**
   * 将 base64 帧数据转换为 ImageBitmap
   */
  const decodeFrameToBitmap = useCallback(async (base64Data: string): Promise<ImageBitmap> => {
    const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    return createImageBitmap(blob);
  }, []);

  /**
   * 预解码所有帧为 ImageBitmap
   */
  const decodeAllFrames = useCallback(async (frames: string[]): Promise<ImageBitmap[]> => {
    console.log(`预解码 ${frames.length} 帧...`);
    const bitmaps = await Promise.all(
      frames.map(frame =>
        frame ? decodeFrameToBitmap(frame) : Promise.resolve(null as unknown as ImageBitmap)
      )
    );
    console.log(`帧解码完成`);
    return bitmaps;
  }, [decodeFrameToBitmap]);

  /**
   * 渲染帧循环（用于 playPrepared）
   */
  const renderFrame = useCallback(() => {
    if (!isPlayingRef.current || !currentDataRef.current) return;

    const audioContext = audioContextRef.current;
    const data = currentDataRef.current;
    const bitmaps = bitmapsRef.current;
    if (!audioContext) return;

    // 计算当前应该显示的帧
    const audioElapsed = audioContext.currentTime - audioStartTimeRef.current;
    const targetFrame = Math.floor(audioElapsed * data.fps);

    // 绘制帧（使用预解码的 ImageBitmap，同步绘制无闪烁）
    if (targetFrame < bitmaps.length && bitmaps[targetFrame]) {
      if (currentFrameRef.current !== targetFrame) {
        drawBitmap(bitmaps[targetFrame]);
        currentFrameRef.current = targetFrame;
      }
    }

    // 继续循环或结束
    if (targetFrame < data.totalFrames) {
      animationFrameIdRef.current = requestAnimationFrame(renderFrame);
    } else {
      // 播放完成 — Canvas 保持可见显示最后一帧，等待下一句或完整停止
      // setLipsyncMode('idle') 由 stop() 在完整停止时调用，或由 runLipsyncPlayLoop 在循环结束后调用
      isPlayingRef.current = false;
      onPlayEndRef.current?.();
      onPlayEndRef.current = null;
    }
  }, [drawBitmap]);

  /**
   * 停止当前播放
   */
  const stop = useCallback((options?: { preserveCanvas?: boolean }) => {
    const preserveCanvas = options?.preserveCanvas ?? false;

    // 停止渲染循环
    if (animationFrameIdRef.current) {
      cancelAnimationFrame(animationFrameIdRef.current);
      animationFrameIdRef.current = null;
    }

    // 停止音频
    if (audioSourceRef.current) {
      try { audioSourceRef.current.stop(); } catch (e) { /* ignore */ }
      audioSourceRef.current = null;
    }

    if (audioContextRef.current) {
      try { audioContextRef.current.close(); } catch (e) { /* ignore */ }
      audioContextRef.current = null;
    }

    // 清理预生成模式的 ImageBitmap 资源
    for (const bitmap of bitmapsRef.current) {
      if (bitmap) {
        bitmap.close();
      }
    }
    bitmapsRef.current = [];

    // 清理流式模式的 ImageBitmap 资源
    for (const bitmap of streamBitmapsRef.current) {
      if (bitmap) {
        bitmap.close();
      }
    }
    streamBitmapsRef.current = [];

    // 清理状态
    audioBufferRef.current = null;
    currentDataRef.current = null;  // sentinel: 标记 stop 已调用（用于解码中断检测）
    isPlayingRef.current = false;
    currentFrameRef.current = 0;

    // 只在非保留 Canvas 时隐藏（preserveCanvas=true 用于句子间无缝切换）
    if (!preserveCanvas) {
      setLipsyncMode('idle');
    }
  }, [setLipsyncMode]);

  /**
   * 预生成帧（可以并行调用多个）
   * 这个函数不会影响当前播放状态
   */
  const prepare = useCallback(async (
    faceFileId: string,
    audioBytes: Uint8Array,
    signal?: AbortSignal
  ): Promise<PreparedLipsyncData> => {
    console.log('开始预生成帧...');

    // 上传音频
    const audioFileId = await uploadAudio(audioBytes);

    if (signal?.aborted) {
      const abortError = new DOMException('已取消', 'AbortError');
      throw abortError;
    }

    // 准备结果
    const result: PreparedLipsyncData = {
      frames: [],
      audioBytes,
      totalFrames: 0,
      fps: 25,
      width: 0,
      height: 0,
    };

    // 生成帧
    await new Promise<void>((resolve, reject) => {
      generateFrames(
        faceFileId,
        audioFileId,
        { ...LIPSYNC_GENERATE_OPTIONS, signal },
        {
          onInfo: (event: LipsyncInfoEvent) => {
            result.totalFrames = event.total_frames;
            // 根据音频时长动态计算实际帧率，不信任后端上报的 fps
            result.fps = event.audio_duration > 0
              ? event.total_frames / event.audio_duration
              : event.fps;
            result.width = event.width;
            result.height = event.height;
            result.frames = new Array(event.total_frames);
          },

          onFrame: (event: LipsyncFrameEvent) => {
            result.frames[event.index] = event.data;
          },

          onComplete: (event: LipsyncCompleteEvent) => {
            console.log(`预生成完成: ${event.total_frames} 帧, ${event.total_time.toFixed(2)}秒`);
            resolve();
          },

          onError: (event) => {
            reject(new Error(event.message));
          },
        }
      ).catch(reject);
    });

    return result;
  }, []);

  /**
   * 播放预生成的数据
   */
  const playPrepared = useCallback(async (
    data: PreparedLipsyncData,
    callbacks: LipsyncPlayerCallbacks = {}
  ): Promise<void> => {
    // 停止之前的播放，但保留 Canvas 内容（显示上一句最后一帧，无缝切换）
    stop({ preserveCanvas: true });

    return new Promise(async (resolve, reject) => {
      try {
        // 保存数据和回调（在解码前设置，作为 stop() 调用的 sentinel）
        currentDataRef.current = data;
        onPlayEndRef.current = () => {
          callbacks.onPlayEnd?.();
          resolve();
        };

        // 设置 Canvas 尺寸
        const canvas = getLipsyncCanvas();
        if (canvas) {
          canvas.width = data.width;
          canvas.height = data.height;
          ctxRef.current = canvas.getContext('2d');
        }

        // 并行解码所有帧为 ImageBitmap
        const decodedBitmaps = await decodeAllFrames(data.frames);

        // Fix E: 检查解码期间是否被 stop() 打断（currentDataRef 被清空为 null）
        if (currentDataRef.current === null) {
          // 关闭孤立的 ImageBitmap，防止 GPU 内存泄漏
          for (const bitmap of decodedBitmaps) {
            if (bitmap) bitmap.close();
          }
          resolve();
          return;
        }

        bitmapsRef.current = decodedBitmaps;

        // 预渲染首帧到 Canvas（在切换显示之前）
        if (bitmapsRef.current.length > 0 && bitmapsRef.current[0]) {
          drawBitmap(bitmapsRef.current[0]);
          console.log('首帧已预渲染');
        }

        // 创建 AudioContext 并解码音频
        audioContextRef.current = new (window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();

        const arrayBuffer = new ArrayBuffer(data.audioBytes.length);
        const view = new Uint8Array(arrayBuffer);
        view.set(data.audioBytes);

        audioBufferRef.current = await audioContextRef.current.decodeAudioData(arrayBuffer);

        // 开始播放
        isPlayingRef.current = true;
        currentFrameRef.current = 0;

        // 播放音频
        audioSourceRef.current = audioContextRef.current.createBufferSource();
        audioSourceRef.current.buffer = audioBufferRef.current;
        audioSourceRef.current.connect(audioContextRef.current.destination);
        audioSourceRef.current.start(0);
        audioStartTimeRef.current = audioContextRef.current.currentTime;

        console.log('开始播放对口型');
        // 此时 Canvas 上已经有首帧内容，切换显示不会闪烁
        setLipsyncMode('playing');
        callbacks.onPlayStart?.();

        // 开始帧渲染循环
        renderFrame();

      } catch (error) {
        console.error('播放失败:', error);
        stop();
        callbacks.onError?.(error instanceof Error ? error : new Error('播放失败'));
        reject(error);
      }
    });
  }, [stop, setLipsyncMode, renderFrame, decodeAllFrames, drawBitmap]);

  /**
   * 帧流播放：帧到达驱动主时钟。
   * AudioContext 仅在有帧可播时 running，无帧时 suspend，保证严格音画同步。
   */
  const playStream = useCallback(async (
    faceFileId: string,
    audioBytes: Uint8Array,
    callbacks: LipsyncPlayerCallbacks = {},
    signal?: AbortSignal
  ): Promise<void> => {
    // 停止之前的播放，保留 Canvas 内容（无缝切换）
    stop({ preserveCanvas: true });

    return new Promise((promiseResolve, promiseReject) => {
      let settled = false;
      const resolve = () => { if (!settled) { settled = true; promiseResolve(); } };
      const reject = (e: unknown) => { if (!settled) { settled = true; promiseReject(e); } };

      (async () => {
        try {
          // Sentinel 对象：stop() 会将 currentDataRef.current 置为 null，
          // 通过 isStopped() 检测可知晓 stop 是否在异步流程中被调用
          const sentinel = {} as PreparedLipsyncData;
          currentDataRef.current = sentinel;
          const isStopped = () => currentDataRef.current !== sentinel;

          // ── 流式状态（局部变量，闭包捕获）──
          let streamBitmaps: (ImageBitmap | null)[] = [];
          let totalFrames = 0;
          let fps = 25;
          let width = 0;
          let height = 0;
          let streamEnded = false;

          // 帧驱动播放状态
          let lastDrawnFrame = -1;       // 最后绘制的帧索引
          let audioReady = false;         // 音频是否已解码并挂载
          let audioRunning = false;       // 本地 flag 跟踪 AudioContext 状态
          let playbackStarted = false;    // 是否已启动播放流程
          let audioCtx: AudioContext | null = null;
          let audioBuffer: AudioBuffer | null = null;

          // 将 streamBitmaps 注册到 ref，使 stop() 能清理已解码的帧
          streamBitmapsRef.current = streamBitmaps;

          // ── 上传音频 ──
          console.log('🎙️ 上传音频...');
          const audioFileId = await uploadAudio(audioBytes);
          if (isStopped() || signal?.aborted) { resolve(); return; }

          // ── 音频 suspend/resume 门控 ──
          // 不检查 audioCtx.state，因为 resume()/suspend() 是异步的，
          // state 切换有延迟，检查它会导致 flag 与真实状态分裂。
          // 只用 audioRunning flag 做幂等守卫。
          const ensureAudioRunning = () => {
            if (!audioRunning && audioCtx) {
              audioRunning = true;
              audioCtx.resume().catch(() => {});
            }
          };

          const ensureAudioSuspended = () => {
            if (audioRunning && audioCtx) {
              audioRunning = false;
              audioCtx.suspend().catch(() => {});
            }
          };

          // ── 核心调度：帧驱动播放推进 ──
          const tryAdvancePlayback = () => {
            if (!isPlayingRef.current || isStopped()) return;

            const nextNeeded = lastDrawnFrame + 1;

            // 结束条件：流已完成 且 下一帧 >= 总帧数
            if (streamEnded && totalFrames > 0 && nextNeeded >= totalFrames) {
              ensureAudioSuspended();
              isPlayingRef.current = false;
              callbacks.onPlayEnd?.();
              resolve();
              return;
            }

            // 下一顺序帧是否已解码？
            if (nextNeeded < streamBitmaps.length && streamBitmaps[nextNeeded] !== null) {
              if (!audioReady) {
                // 音频尚未就绪，rAF 轮询等待（不调用 ensureAudioRunning，audioCtx 还不存在）
                animationFrameIdRef.current = requestAnimationFrame(tryAdvancePlayback);
                return;
              }

              // 有帧可播且音频就绪 → 确保音频 running
              ensureAudioRunning();

              // 检查音频时钟是否已到该帧的时间
              const audioElapsed = audioCtx!.currentTime - audioStartTimeRef.current;
              const frameTime = nextNeeded / fps;

              if (audioElapsed >= frameTime) {
                // 音频已到达或超过该帧时间 → 绘制
                drawBitmap(streamBitmaps[nextNeeded]!);
                lastDrawnFrame = nextNeeded;
                currentFrameRef.current = nextNeeded;
                // 立即尝试下一帧（可能连续多帧已就绪）
                animationFrameIdRef.current = requestAnimationFrame(tryAdvancePlayback);
              } else {
                // 后端快于实时 → 音频时钟限速，帧不会提前绘制
                animationFrameIdRef.current = requestAnimationFrame(tryAdvancePlayback);
              }
            } else {
              // 下一帧未到 → suspend 音频（冻结音频+时钟），等 onFrameDecoded 触发
              ensureAudioSuspended();
              // 不调度 rAF，由 onFrameDecoded 重新触发
            }
          };

          // ── 每帧解码完成后的回调 ──
          const onFrameDecoded = (index: number) => {
            if (isStopped()) return;

            // 如果是下一顺序帧，重新触发调度
            if (index === lastDrawnFrame + 1) {
              if (isPlayingRef.current) {
                tryAdvancePlayback();
              }
            }

            // 如果尚未启动播放且第一帧已就绪，启动
            if (!playbackStarted && index === 0) {
              startPlayback().catch(err => {
                if (!isStopped()) reject(err);
              });
            }
          };

          // ── 并行：启动音频解码（与 SSE 流同步进行）──
          const audioDecodePromise = (async () => {
            const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            const ctx = new AudioCtx();
            // 创建后立即 suspend，由帧驱动 resume
            await ctx.suspend();
            const ab = new ArrayBuffer(audioBytes.length);
            new Uint8Array(ab).set(audioBytes);
            const buffer = await ctx.decodeAudioData(ab);
            return { ctx, buffer };
          })();

          // ── 启动播放（首帧解码完成时调用）──
          const startPlayback = async () => {
            if (playbackStarted || isStopped()) return;
            playbackStarted = true;

            // 设置 Canvas
            const canvas = getLipsyncCanvas();
            if (canvas) {
              canvas.width = width;
              canvas.height = height;
              ctxRef.current = canvas.getContext('2d');
            }

            // 预渲染首帧
            if (streamBitmaps[0]) {
              drawBitmap(streamBitmaps[0]);
              lastDrawnFrame = 0;
              currentFrameRef.current = 0;
              console.log('🖼️ 首帧已预渲染');
            }

            isPlayingRef.current = true;
            setLipsyncMode('playing');
            callbacks.onPlayStart?.();

            console.log('▶️ 帧流播放开始（帧驱动模式）');

            // 设置音频（异步，完成后标记 audioReady）
            setupAudio().catch(err => {
              if (!isStopped()) reject(err);
            });

            // 立即开始调度（即使音频未就绪，也可以先绘制已有帧）
            tryAdvancePlayback();
          };

          // ── 设置音频：创建 source 并 start(0)，保持 suspended ──
          const setupAudio = async () => {
            const { ctx, buffer } = await audioDecodePromise;
            if (isStopped()) { ctx.close().catch(() => {}); return; }

            audioCtx = ctx;
            audioBuffer = buffer;
            audioContextRef.current = ctx;
            audioBufferRef.current = buffer;

            // 创建 source 并 start(0)，但 AudioContext 仍然 suspended
            audioSourceRef.current = ctx.createBufferSource();
            audioSourceRef.current.buffer = buffer;
            audioSourceRef.current.connect(ctx.destination);
            audioSourceRef.current.start(0);
            audioStartTimeRef.current = ctx.currentTime;
            audioRunning = false;

            audioReady = true;
            console.log('🔊 音频已就绪（suspended，等待帧驱动）');

            // 音频就绪后，重新触发调度（可能有帧在等待音频）
            if (isPlayingRef.current) {
              tryAdvancePlayback();
            }
          };

          // ── SSE 帧流 ──
          const decodePromises: Promise<void>[] = [];

          await generateFrames(
            faceFileId,
            audioFileId,
            { ...LIPSYNC_GENERATE_OPTIONS, signal },
            {
              onInfo: (event) => {
                totalFrames = event.total_frames;
                // 根据音频时长动态计算实际帧率
                fps = event.audio_duration > 0
                  ? event.total_frames / event.audio_duration
                  : event.fps;
                width = event.width;
                height = event.height;
                streamBitmaps = new Array(totalFrames).fill(null);
                streamBitmapsRef.current = streamBitmaps;
                console.log(`📊 流信息: ${totalFrames} 帧, ${fps.toFixed(1)} fps (实际), ${width}×${height}`);
              },

              onFrame: (event: LipsyncFrameEvent) => {
                // 立即异步解码，不阻塞 SSE 读取
                const decodeP = decodeFrameToBitmap(event.data).then(bitmap => {
                  if (isStopped()) {
                    bitmap.close();
                    return;
                  }
                  streamBitmaps[event.index] = bitmap;
                  onFrameDecoded(event.index);
                }).catch(err => {
                  console.warn(`帧 ${event.index} 解码失败:`, err);
                });
                decodePromises.push(decodeP);
              },

              onComplete: (event: LipsyncCompleteEvent) => {
                totalFrames = event.total_frames;
                streamEnded = true;
                console.log(`✅ SSE 完成: ${event.total_frames} 帧, ${event.total_time.toFixed(2)}s`);

                // 0 帧响应：直接结束
                if (totalFrames === 0) {
                  if (!playbackStarted) resolve();
                  return;
                }

                // 流结束后重新触发调度（可能所有帧已到但正在等待）
                if (isPlayingRef.current) {
                  tryAdvancePlayback();
                }

                // 若从未启动（所有帧在首帧解码前到达？不太可能但处理边界）
                if (!playbackStarted) {
                  Promise.all(decodePromises).then(() => {
                    if (!isStopped() && !playbackStarted) {
                      startPlayback().catch(err => {
                        if (!isStopped()) reject(err);
                      });
                    }
                  });
                }
              },

              onError: (event) => {
                reject(new Error(event.message));
              },
            }
          );

          // 等待所有帧解码完成
          await Promise.all(decodePromises);

          // 若从未启动（0 帧响应），直接 resolve
          if (!playbackStarted && !isStopped()) {
            resolve();
          }
          // 若已启动，由 tryAdvancePlayback 在播放结束时 resolve

        } catch (error) {
          if (
            currentDataRef.current === null ||  // stop() 调用
            (error instanceof DOMException && error.name === 'AbortError') ||
            (error instanceof Error && error.name === 'AbortError')
          ) {
            resolve();
            return;
          }
          console.error('帧流播放失败:', error);
          callbacks.onError?.(error instanceof Error ? error : new Error('帧流播放失败'));
          reject(error);
        }
      })();
    });
  }, [stop, setLipsyncMode, drawBitmap, decodeFrameToBitmap]);

  /**
   * 检查是否正在播放
   */
  const isPlaying = useCallback(() => {
    return isPlayingRef.current;
  }, []);

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return {
    prepare,
    playPrepared,
    playStream,
    stop,
    isPlaying,
  };
}
