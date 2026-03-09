"use client";

import { useCallback, useEffect, useRef } from "react";
import { useAvatarStore } from "@/store/avatarStore";
import { AVATAR_LIST } from "@/types/avatar";
import { uploadFaceImage } from "@/services/lipsync";
import styles from "./style.module.css";

/**
 * Avatar 视频播放组件
 * 根据当前状态（idle/talk/dance/think）播放对应视频
 * 当 action = 'talk' 且 lipsync 启用时，显示 Canvas 渲染对口型帧
 * 
 * 使用多个预加载的 video 元素，通过 CSS visibility 切换，避免重新加载导致的闪烁
 */
export function AvatarVideo() {
  const { 
    currentAvatarId, 
    action, 
    setAction,
    lipsyncEnabled,
    lipsyncMode,
    faceFileId,
    setFaceFileId,
  } = useAvatarStore();
  
  // 视频元素 refs
  const idleVideoRef = useRef<HTMLVideoElement>(null);
  const thinkVideoRef = useRef<HTMLVideoElement>(null);
  const danceVideoRef = useRef<HTMLVideoElement>(null);
  
  // 获取当前形象数据
  const currentAvatar = AVATAR_LIST.find((a) => a.id === currentAvatarId) || AVATAR_LIST[0];
  
  // 当 action='talk' 但 lipsync 未在播放时，使用 think 视频作为过渡（避免句子间隙闪烁）
  const effectiveAction = (action === 'talk' && lipsyncEnabled && lipsyncMode !== 'playing') 
    ? 'think' 
    : action;

  // 是否显示 Canvas（talk 状态且 lipsync 启用且正在播放）
  const showCanvas = action === 'talk' && lipsyncEnabled && lipsyncMode === 'playing';

  // 处理 dance 视频结束事件
  const handleDanceEnded = useCallback(() => {
    setAction("idle");
  }, [setAction]);

  // 处理视频加载错误
  const handleError = useCallback((videoType: string) => {
    console.error(`视频加载失败: ${videoType}`);
  }, []);

  // 当 effectiveAction 变化时，确保对应视频从头播放
  useEffect(() => {
    const videoRef = 
      effectiveAction === 'idle' ? idleVideoRef :
      effectiveAction === 'think' ? thinkVideoRef :
      effectiveAction === 'dance' ? danceVideoRef : null;
    
    if (videoRef?.current && !showCanvas) {
      // 重置到开头并播放
      videoRef.current.currentTime = 0;
      videoRef.current.play().catch(() => {
        // 自动播放可能被阻止，忽略错误
      });
    }
  }, [effectiveAction, showCanvas]);

  // 应用启动或 avatar 切换时，获取人脸文件 ID 用于对口型
  useEffect(() => {
    if (lipsyncEnabled && currentAvatarId && !faceFileId) {
      if (currentAvatar.faceFileId) {
        // 直接使用预配置的服务器文件 ID，跳过上传
        console.log('使用预配置人脸文件 ID:', currentAvatar.faceFileId);
        setFaceFileId(currentAvatar.faceFileId);
      } else {
        // 上传人脸视频并获取 ID
        console.log('上传 avatar 人脸视频:', currentAvatar.faceImage);
        uploadFaceImage(currentAvatar.faceImage)
          .then(fileId => {
            console.log('人脸视频上传成功:', fileId);
            setFaceFileId(fileId);
          })
          .catch(err => {
            console.error('上传人脸视频失败:', err);
          });
      }
    }
  }, [currentAvatarId, lipsyncEnabled, faceFileId, currentAvatar.faceImage, currentAvatar.faceFileId, setFaceFileId]);

  // 判断某个视频是否应该显示
  const isVideoVisible = (videoAction: string) => {
    return effectiveAction === videoAction && !showCanvas;
  };

  return (
    <div className={styles.container}>
      {/* idle 视频 - 预加载，循环播放 */}
      <video
        ref={idleVideoRef}
        src={currentAvatar.videos.idle}
        className={`${styles.video} ${isVideoVisible('idle') ? '' : styles.hidden}`}
        autoPlay
        loop
        playsInline
        muted
        onError={() => handleError('idle')}
      />
      
      {/* think 视频 - 预加载，循环播放 */}
      <video
        ref={thinkVideoRef}
        src={currentAvatar.videos.think}
        className={`${styles.video} ${isVideoVisible('think') ? '' : styles.hidden}`}
        autoPlay
        loop
        playsInline
        muted
        onError={() => handleError('think')}
      />
      
      {/* dance 视频 - 预加载，不循环，播放完切回 idle */}
      <video
        ref={danceVideoRef}
        src={currentAvatar.videos.dance}
        className={`${styles.video} ${isVideoVisible('dance') ? '' : styles.hidden}`}
        autoPlay
        playsInline
        onEnded={handleDanceEnded}
        onError={() => handleError('dance')}
      />
      
      {/* Canvas 元素：用于 lip-sync 实时渲染 */}
      <canvas
        id="lipsync-canvas"
        className={`${styles.canvas} ${showCanvas ? '' : styles.hidden}`}
      />
    </div>
  );
}

// 导出 canvas ref 获取函数，供 useLipsyncPlayer 使用
export function getLipsyncCanvas(): HTMLCanvasElement | null {
  return document.getElementById('lipsync-canvas') as HTMLCanvasElement | null;
}
