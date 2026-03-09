/**
 * Lip-sync 服务封装
 * 提供与 Wav2Lip 后端交互的方法
 */

/** SSE 事件类型 */
export interface LipsyncStartEvent {
  type: 'start';
  message: string;
}

export interface LipsyncStatusEvent {
  type: 'status';
  message: string;
}

export interface LipsyncInfoEvent {
  type: 'info';
  total_frames: number;
  fps: number;
  width: number;
  height: number;
  audio_duration: number;
  audio_url: string;
}

export interface LipsyncFrameEvent {
  type: 'frame';
  index: number;
  data: string;  // base64 encoded JPEG
  progress: number;
}

export interface LipsyncAudioChunkEvent {
  type: 'audio_chunk';
  data: string;  // base64 encoded audio data
  index: number;
}

export interface LipsyncCompleteEvent {
  type: 'complete';
  total_frames: number;
  total_time: number;
  fps_actual: number;
}

export interface LipsyncErrorEvent {
  type: 'error';
  message: string;
}

export type LipsyncEvent =
  | LipsyncStartEvent
  | LipsyncStatusEvent
  | LipsyncInfoEvent
  | LipsyncFrameEvent
  | LipsyncAudioChunkEvent
  | LipsyncCompleteEvent
  | LipsyncErrorEvent;

/** 上传响应 */
export interface UploadResponse {
  file_id: string;
}

/**
 * 上传人脸文件（支持图片或视频）
 * @param fileUrl 文件 URL（来自 public 目录）
 * @returns file_id
 */
export async function uploadFaceImage(fileUrl: string): Promise<string> {
  console.log('开始上传人脸文件:', fileUrl);
  
  // 先获取文件数据
  const fileResponse = await fetch(fileUrl);
  if (!fileResponse.ok) {
    throw new Error(`无法获取文件: ${fileResponse.status}`);
  }
  
  // 使用 arrayBuffer 确保数据完整性
  const arrayBuffer = await fileResponse.arrayBuffer();
  // 根据 URL 扩展名或响应头判断类型
  let contentType = fileResponse.headers.get('content-type');
  if (!contentType || contentType === 'application/octet-stream') {
    // 根据扩展名判断
    if (fileUrl.endsWith('.mp4')) {
      contentType = 'video/mp4';
    } else if (fileUrl.endsWith('.png')) {
      contentType = 'image/png';
    } else if (fileUrl.endsWith('.jpg') || fileUrl.endsWith('.jpeg')) {
      contentType = 'image/jpeg';
    } else {
      contentType = 'application/octet-stream';
    }
  }
  const fileBlob = new Blob([arrayBuffer], { type: contentType });
  
  console.log(`文件获取成功: 大小=${fileBlob.size} bytes, 类型=${fileBlob.type}`);
  
  // 从 URL 提取文件名
  const fileName = fileUrl.split('/').pop() || 'avatar.mp4';
  
  const formData = new FormData();
  formData.append('file', fileBlob, fileName);
  
  const response = await fetch('/api/lipsync/upload-face', {
    method: 'POST',
    body: formData,
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: '上传失败' }));
    console.error('上传人脸文件失败:', error);
    throw new Error(error.error || error.details || '上传人脸文件失败');
  }
  
  const data: UploadResponse = await response.json();
  console.log('人脸文件上传成功, file_id:', data.file_id);
  return data.file_id;
}

/**
 * 上传 TTS 音频
 * @param audioBytes 音频字节数据
 * @returns file_id
 */
export async function uploadAudio(audioBytes: Uint8Array): Promise<string> {
  // Copy into a fresh Uint8Array to avoid SharedArrayBuffer typing issues
  const safeBytes = new Uint8Array(audioBytes);
  const blob = new Blob([safeBytes], { type: 'audio/mp3' });
  const formData = new FormData();
  formData.append('file', blob, 'tts-audio.mp3');
  
  const response = await fetch('/api/lipsync/upload-audio', {
    method: 'POST',
    body: formData,
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: '上传失败' }));
    throw new Error(error.error || error.details || '上传音频失败');
  }
  
  const data: UploadResponse = await response.json();
  return data.file_id;
}

/** 生成选项 */
export interface GenerateOptions {
  batchSize?: number;
  outputFps?: number;
  jpegQuality?: number;
  resizeFactor?: number;
  signal?: AbortSignal;
}

/** 生成回调 */
export interface GenerateCallbacks {
  onStart?: (event: LipsyncStartEvent) => void;
  onStatus?: (event: LipsyncStatusEvent) => void;
  onInfo?: (event: LipsyncInfoEvent) => void;
  onFrame?: (event: LipsyncFrameEvent) => void;
  onAudioChunk?: (event: LipsyncAudioChunkEvent) => void;
  onComplete?: (event: LipsyncCompleteEvent) => void;
  onError?: (event: LipsyncErrorEvent) => void;
}

/**
 * 流式生成对口型帧
 * @param faceFileId 人脸文件 ID
 * @param audioFileId 音频文件 ID
 * @param options 生成选项
 * @param callbacks 事件回调
 */
export async function generateFrames(
  faceFileId: string,
  audioFileId: string,
  options: GenerateOptions = {},
  callbacks: GenerateCallbacks = {}
): Promise<void> {
  const formData = new FormData();
  formData.append('face_file_id', faceFileId);
  formData.append('audio_file_id', audioFileId);
  
  if (options.batchSize) formData.append('batch_size', options.batchSize.toString());
  if (options.outputFps) formData.append('output_fps', options.outputFps.toString());
  if (options.jpegQuality) formData.append('jpeg_quality', options.jpegQuality.toString());
  if (options.resizeFactor) formData.append('resize_factor', options.resizeFactor.toString());
  
  const response = await fetch('/api/lipsync/generate', {
    method: 'POST',
    body: formData,
    signal: options.signal,
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: '生成失败' }));
    throw new Error(error.error || error.details || '生成帧失败');
  }
  
  if (!response.body) {
    throw new Error('响应体为空');
  }
  
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  
  try {
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      
      // 解析 SSE 事件
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6).trim();
          if (jsonStr && jsonStr !== '[DONE]') {
            try {
              const event = JSON.parse(jsonStr) as LipsyncEvent;
              
              switch (event.type) {
                case 'start':
                  callbacks.onStart?.(event);
                  break;
                case 'status':
                  callbacks.onStatus?.(event);
                  break;
                case 'info':
                  callbacks.onInfo?.(event);
                  break;
                case 'frame':
                  callbacks.onFrame?.(event);
                  break;
                case 'audio_chunk':
                  callbacks.onAudioChunk?.(event);
                  break;
                case 'complete':
                  callbacks.onComplete?.(event);
                  break;
                case 'error':
                  callbacks.onError?.(event);
                  break;
              }
            } catch (e) {
              console.error('解析 SSE 事件失败:', e, jsonStr);
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
