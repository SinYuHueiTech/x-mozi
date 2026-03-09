export type AvatarAction = 'idle' | 'talk' | 'dance' | 'think';

export interface AvatarModel {
  id: string;
  name: string;
  thumbnail: string;    // 预览缩略图：/avatars/avatar-${id}-preview.png
  faceImage: string;    // 对口型视频源（用于上传到 Wav2Lip 服务器）
  faceFileId?: string;  // 服务器已有的人脸文件 ID，填写后跳过上传直接使用
  videos: {
    idle: string;
    talk: string;
    dance: string;
    think: string;     // 思考/等待动画
  };
}

/**
 * 创建 Avatar 模型数据
 * @param id Avatar ID
 * @param name 显示名称
 */
function createAvatar(id: string, name: string): AvatarModel {
  const basePath = `/videos/avatar-${id}`;
  return {
    id,
    name,
    thumbnail: `/avatars/avatar-${id}-preview.png`,  // 预览图
    faceImage: `${basePath}/avatar-${id}-talk.mp4`,  // 对口型视频源
    videos: {
      idle: `${basePath}/avatar-${id}-idle.mp4`,
      talk: `${basePath}/avatar-${id}-talk.mp4`,
      dance: `${basePath}/avatar-${id}-dance.mp4`,
      think: `${basePath}/avatar-${id}-think.mp4`,   // 等待生成时播放
    },
  };
}

/**
 * Avatar 形象列表
 */
export const AVATAR_LIST: AvatarModel[] = [
  // createAvatar('1', '形象 1'),
  {
    ...createAvatar('2', '形象 2'),
    faceFileId: '3fb12802847f4647b7e6f9af26726185.mp4',  // 填服务器返回的文件 ID
  }
  // createAvatar('3', '形象 3'),
  // createAvatar('4', '形象 4'),
  // createAvatar('5', '形象 5'),
];

/**
 * 根据 ID 获取 Avatar
 */
export function getAvatarById(id: string): AvatarModel | undefined {
  return AVATAR_LIST.find(avatar => avatar.id === id);
}

/**
 * 获取默认 Avatar
 */
export function getDefaultAvatar(): AvatarModel {
  return AVATAR_LIST[0];
}
