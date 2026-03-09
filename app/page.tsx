"use client";

import { useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import dynamic from "next/dynamic";
import { AvatarVideo } from "@/components/AvatarVideo";
import { ChatPanel } from "@/components/ChatPanel";
import { useVoiceInteraction } from "@/hooks/useVoiceInteraction";
import { useWakeWord } from "@/hooks/useWakeWord";
import { useCameraWake } from "@/hooks/useCameraWake";
import { useAvatarStore } from "@/store/avatarStore";
import { useChatStore } from "@/store/chatStore";
import { useLanguageStore } from "@/store/languageStore";
import { useWakeStore } from "@/store/wakeStore";
import { AVATAR_LIST } from "@/types/avatar";
import type { VoiceButtonRef } from "@/components/VoiceButton";
import { DEFAULT_WAKE_WORDS } from "@/constants/audio";
import { TranslationOutlined } from "@ant-design/icons";

// Dynamic import VoiceButton
const VoiceButton = dynamic(
  () => import("@/components/VoiceButton").then((mod) => mod.VoiceButton),
  { ssr: false }
);

// Expose stores to window for console debugging
if (typeof window !== 'undefined') {
  (window as Window & { 
    avatarStore?: typeof useAvatarStore; 
    chatStore?: typeof useChatStore;
    wakeStore?: typeof useWakeStore;
  }).avatarStore = useAvatarStore;
  (window as Window & { chatStore?: typeof useChatStore }).chatStore = useChatStore;
  (window as Window & { wakeStore?: typeof useWakeStore }).wakeStore = useWakeStore;
}

export default function Home() {
  const { setAvatarId, currentAvatarId, action } = useAvatarStore();
  const { isProcessing, handleTextInput, interrupt } = useVoiceInteraction();
  const { language, toggleLanguage } = useLanguageStore();
  const { isRecording, setIsRecording, phase } = useWakeStore();
  const isEnglish = language === 'en';
  const isTalking = action === 'talk';
  
  // VoiceButton ref（用于唤醒模式自动触发）
  const voiceButtonRef = useRef<VoiceButtonRef>(null);

  // 识别完成回调 - 发送给 AI
  const handleResult = useCallback((text: string) => {
    console.log('📝 识别完成:', text);
    handleTextInput(text);
  }, [handleTextInput]);

  // 唤醒词触发 - 自动开始录音
  const handleWakeUp = useCallback(() => {
    console.log('🎤 唤醒词触发，自动开始录音');
    // 自动触发录音按钮
    if (voiceButtonRef.current && !isProcessing) {
      voiceButtonRef.current.startRecording();
    }
  }, [isProcessing]);

  // 唤醒词监听（语音唤醒）
  const { isListening: isWakeListening, startListening, stopListening } = useWakeWord({
    wakeWords: DEFAULT_WAKE_WORDS,
    onWakeUp: handleWakeUp,
  });

  // 摄像头人体检测唤醒（录音中或 AI 回答时禁用）
  const { isDetecting: isCameraDetecting, mediaStream: cameraStream, startDetecting, stopDetecting } = useCameraWake({
    onWakeUp: handleWakeUp,
    disabled: isProcessing || isRecording,
  });

  // 摄像头预览 - 使用 callback ref 确保流正确绑定
  const cameraPreviewRef = useCallback((video: HTMLVideoElement | null) => {
    if (video && cameraStream) {
      video.srcObject = cameraStream;
    }
  }, [cameraStream]);

  // 暴露唤醒控制到 window（控制台使用）
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const win = window as Window & {
        startWakeWord?: () => void;
        stopWakeWord?: () => void;
        isWakeWordEnabled?: () => boolean;
        startCameraWake?: () => void;
        stopCameraWake?: () => void;
        isCameraWakeEnabled?: () => boolean;
        wake?: () => void;
        unwake?: () => void;
        chat?: (text: string) => void;
      };

      // 文字发送指令（调试用）
      win.chat = (text: string) => {
        if (!text?.trim()) {
          console.warn('用法: chat("你好墨子")');
          return;
        }
        handleTextInput(text);
      };

      // 语音唤醒控制
      win.startWakeWord = () => {
        startListening();
        console.log('🎤 语音唤醒已开启，说"你好墨子"或"墨子"唤醒');
      };
      win.stopWakeWord = () => {
        stopListening();
        console.log('🎤 语音唤醒已关闭');
      };
      win.isWakeWordEnabled = () => isWakeListening;

      // 摄像头唤醒控制
      win.startCameraWake = () => {
        startDetecting();
        console.log('📷 摄像头唤醒已开启，检测到人持续 2 秒后唤醒');
      };
      win.stopCameraWake = () => {
        stopDetecting();
        console.log('📷 摄像头唤醒已关闭');
      };
      win.isCameraWakeEnabled = () => isCameraDetecting;

      // 便捷命令：同时开启/关闭两种唤醒
      win.wake = () => {
        startListening();
        startDetecting();
        console.log('🚀 已开启语音唤醒 + 摄像头唤醒');
      };
      win.unwake = () => {
        stopListening();
        stopDetecting();
        console.log('🛑 已关闭所有唤醒');
      };
    }
  }, [startListening, stopListening, isWakeListening, startDetecting, stopDetecting, isCameraDetecting, handleTextInput]);

  // Log console usage hint on mount
  useEffect(() => {
    console.log(`
💬 发送文字 (调试):
  chat("你好墨子")        // 直接发送文字给 AI

🚀 唤醒命令:
  wake()                 // 同时开启语音+摄像头唤醒
  unwake()               // 关闭所有唤醒

🎤 语音唤醒:
  startWakeWord()        // 开启
  stopWakeWord()         // 关闭
  唤醒词: "你好墨子"、"墨子"

📷 摄像头唤醒:
  startCameraWake()      // 开启
  stopCameraWake()       // 关闭
  检测到人持续 2 秒后唤醒
    `);
  }, []);

  return (
    <main className="flex flex-col h-full w-full bg-page">
      {/* 摄像头预览 - 右上角 */}
      {isCameraDetecting && cameraStream && (
        <div className="fixed top-4 right-4 z-50">
          <div className="relative rounded-lg overflow-hidden shadow-lg border-2 border-primary/50">
            <video
              ref={cameraPreviewRef}
              autoPlay
              playsInline
              muted
              className="w-32 h-24 object-cover transform scale-x-[-1]"
            />
            <div className="absolute bottom-1 left-1 px-1.5 py-0.5 bg-black/60 rounded text-[10px] text-white flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
              检测中
            </div>
          </div>
        </div>
      )}

      {/* 顶部主体区域 */}
      <div className="flex flex-1 w-full overflow-hidden">
        {/* 左侧区域：智能体展示 (约66%) */}
        <section className="flex flex-col flex-2 h-full border-r border-border relative">
          {/* 左上角状态提示 */}
          {phase !== 'idle' && (
            <div className="absolute top-4 left-4 z-40">
              <div className={`px-4 py-2 rounded-full backdrop-blur-sm flex items-center gap-2 ${
                phase === 'thinking' 
                  ? 'bg-primary/80 text-primary-foreground' 
                  : 'bg-success/80 text-success-foreground'
              }`}>
                {phase === 'thinking' ? (
                  <>
                    <span className="animate-pulse">●</span>
                    <span className="text-sm font-medium">正在思考...</span>
                  </>
                ) : (
                  <>
                    <span className="animate-pulse">●</span>
                    <span className="text-sm font-medium">正在回答...</span>
                  </>
                )}
              </div>
            </div>
          )}

          {/* 视频播放容器 - 自适应剩余空间 */}
          <div className="flex-1 w-full flex items-center justify-center overflow-hidden min-h-0 mb-4">
            <div className="relative h-full aspect-9/16">
               <AvatarVideo />
            </div>
          </div>

          {/* 悬浮控件：左侧形象列表，右侧功能按钮（垂直居中） */}
          <div className="absolute inset-0 z-30 pointer-events-none" style={{ overflow: "visible" }}>
            <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 flex items-start justify-between px-4 sm:px-6 md:px-10 gap-6">
              <div className="pointer-events-auto flex flex-col gap-2 overflow-y-auto max-h-[70vh] w-24 scrollbar-none p-1 shrink-0">
                {AVATAR_LIST.map((avatar) => (
                  <button
                    key={avatar.id}
                    onClick={() => setAvatarId(avatar.id)}
                    className={`relative w-16 h-16 rounded-lg overflow-hidden border-2 transition-all shrink-0 ${
                      currentAvatarId === avatar.id 
                        ? 'border-primary opacity-100 scale-105 ring-2 ring-primary/30' 
                        : 'border-muted-foreground opacity-60 hover:opacity-100'
                    }`}
                    title={avatar.name}
                  >
                    <div className="absolute inset-0 bg-secondary-foreground flex items-center justify-center text-[10px] text-muted font-medium p-1 text-center leading-tight">
                      {avatar.name}
                    </div>
                    <Image 
                      src={avatar.thumbnail} 
                      alt={avatar.name} 
                      fill
                      sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
                      className="absolute inset-0 w-full h-full object-cover"
                      onError={(e) => {
                        const target = e.target as HTMLImageElement;
                        target.style.display = 'none';
                      }}
                    />
                  </button>
                ))}
              </div>

              <div className="pointer-events-auto flex flex-col items-end gap-4 sm:gap-5 shrink-0">
                <div className="flex flex-col items-center gap-1">
                  <button
                    onClick={() => useAvatarStore.getState().setAction('dance')}
                    disabled={isTalking}
                    className={`w-16 h-16 rounded-full border flex items-center justify-center transition-all active:scale-95 ${
                      isTalking
                        ? 'bg-white/20 text-muted-foreground border-white/20 cursor-not-allowed'
                        : 'bg-overlay-bg hover:bg-card text-foreground border-white/60'
                    }`}
                    title="跳舞"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 48 48"><g fill="none" stroke="currentColor" strokeWidth="4"><path strokeLinecap="round" strokeLinejoin="round" d="m8 10l12 10.254v9.714L10.857 44M40 10L28 20.254v9.714L37.143 44"/><circle cx="24" cy="8" r="4"/></g></svg>
                  </button>
                  <span className="text-xs text-overlay-text">跳舞</span>
                </div>

                <div className="flex flex-col items-center gap-1" style={{ overflow: "visible" }}>
                  <VoiceButton 
                    ref={voiceButtonRef}
                    onResult={handleResult}
                    isProcessing={isProcessing}
                    onRecordingChange={setIsRecording}
                    onInterrupt={interrupt}
                  />
                  <span className="text-xs text-overlay-text">
                    {isProcessing ? '点击打断' : '点击说话'}
                  </span>
                </div>

                <div className="flex flex-col items-center gap-1">
                  <button
                    type="button"
                    onClick={toggleLanguage}
                    className={`w-16 h-16 rounded-full border flex items-center justify-center transition-all active:scale-95 ${
                      isEnglish
                        ? 'bg-primary text-primary-foreground border-primary hover:opacity-90'
                        : 'bg-card text-muted-foreground border-border hover:bg-secondary'
                    }`}
                    title={isEnglish ? 'Switch to Chinese' : '切换到英文'}
                    aria-label={isEnglish ? 'Switch to Chinese' : '切换到英文'}
                  >
                    <TranslationOutlined className="text-lg" />
                  </button>
                  <span className="text-xs text-overlay-text">{isEnglish ? 'English' : '中文'}</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 右侧区域：对话交互 (约33%) */}
        {false && (
          <section className="flex flex-col flex-1 h-full bg-white relative border-l border-gray-100">
            <ChatPanel />
          </section>
        )}
      </div>

    </main>
  );
}
