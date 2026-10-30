// 无需构建 npm。填写自己的 AppID（project.config.json）和云环境 ID 后开通师生同步。
module.exports = {
  cloudEnv: '',
  functionName: 'learning',
  // 当前 List 1 默认从随包音频播放。扩充词书后可改用自己的 HTTPS 音频地址。
  audioBaseUrl: 'https://fitzleewenlei.github.io/English-learning',
  // 上传 audio-resources/audio 后填写云文件根，如 cloud://你的环境.你的存储桶。
  audioCloudRoot: '',
  bundledAudio: true,
  defaultDailyGoal: 15,
  sourceWebsite: 'https://fitzleewenlei.github.io/English-learning/',
  version: '2.0.0'
};
