# Render 部署 - 证件照功能问题解决方案

## 问题描述

在 Render 免费实例上运行证件照功能时，可能会遇到以下错误：
```
[ERROR] [照片转证件照] 处理失败: REMOTE_REQUEST_FAILED
```

日志显示服务器在 "创建会话 u2net-human-seg" 后崩溃并重启。

## 根本原因

Render 免费实例有以下限制：
- **内存限制**：512MB RAM
- **CPU 限制**：共享 CPU
- **超时限制**：请求超过 100 秒会被终止

ONNX 模型（u2net_human_seg.onnx 约 168MB）加载时会占用大量内存，容易导致：
1. 内存溢出（OOM）
2. 加载超时
3. 进程崩溃

## 解决方案

### 方案 1：禁用模型，使用降级方案（推荐）

在 Render 的环境变量中添加：
```
PHOTO_ID_DISABLE_MODEL=true
```

这将禁用 ONNX 模型，使用以下降级方案：
- 统一背景移除算法（适用于纯色背景）
- 简单的边缘检测和裁剪

**优点**：
- 内存占用极低
- 处理速度快
- 不会崩溃

**缺点**：
- 复杂背景的图片处理效果可能不如 AI 模型

### 方案 2：启用模型但优化配置

在 Render 的环境变量中添加：
```
PHOTO_ID_DISABLE_MODEL=false
PHOTO_ID_WARM_MODEL=false
```

代码已进行以下优化：
- 使用 CPU 执行提供程序（避免 GPU 内存问题）
- 限制线程数为 1（减少内存使用）
- 增加超时时间到 60 秒（模型加载）和 120 秒（推理）
- 延迟模型预热 5 秒（避免启动时内存压力）

### 方案 3：升级到 Render 付费实例

如果必须使用 AI 模型，建议升级到：
- **Starter 计划**：512MB RAM（可能仍不够稳定）
- **Standard 计划**：1GB RAM（推荐）

## 部署步骤

1. 在 Render Dashboard 中打开你的服务
2. 点击 "Environment" 标签
3. 添加环境变量：
   - `PHOTO_ID_DISABLE_MODEL=true`（如果使用方案 1）
   - 或 `PHOTO_ID_WARM_MODEL=false`（如果使用方案 2）
4. 点击 "Manual Deploy" -> "Deploy latest commit"
5. 等待部署完成

## 验证修复

部署完成后，访问健康检查端点：
```
https://your-service.onrender.com/health
```

应该看到类似响应：
```json
{
  "ok": true,
  "capabilities": {
    "photoId": true,
    "photoIdModel": "disabled"
  },
  "photoId": {
    "modelStatus": "disabled",
    "modelDisabled": true,
    "warmModelEnabled": false
  }
}
```

## 测试证件照功能

1. 打开微信小程序
2. 进入 "我的 -> 云服务"
3. 确认后端地址正确
4. 尝试使用 "证件照" 功能
5. 如果成功，会显示处理完成的证件照

## 故障排除

如果仍然失败，请检查：

1. **查看 Render 日志**：
   - 进入 Render Dashboard -> Logs
   - 查找 `[photo-id]` 相关的日志

2. **检查模型文件是否存在**：
   ```bash
   # 在 Render Shell 中运行
   ls -la /app/backend/storage/models/
   ```

3. **测试健康检查端点**：
   ```bash
   curl https://your-service.onrender.com/health
   ```

4. **检查内存使用情况**：
   - Render Dashboard -> Metrics
   - 查看内存使用是否接近 512MB 限制

## 代码修改说明

本次修复包含以下代码修改：

1. **photo-id.js**:
   - 添加 `PHOTO_ID_DISABLE_MODEL` 环境变量支持
   - 优化 ONNX 会话配置（CPU 执行、单线程）
   - 增加超时时间
   - 添加更完善的错误处理

2. **server.js**:
   - 修改模型预热逻辑，支持禁用选项
   - 延迟预热 5 秒
   - 健康检查端点添加 photo-id 状态报告

3. **.env.example**:
   - 添加 `PHOTO_ID_DISABLE_MODEL` 和 `PHOTO_ID_WARM_MODEL` 配置项

## 建议

对于 Render 免费实例，**强烈推荐使用方案 1**（禁用模型）：
- 稳定性最高
- 响应速度最快
- 不会意外崩溃

如果确实需要 AI 抠图功能，建议：
- 使用付费实例（Standard 计划或更高）
- 或考虑使用第三方 API（如 remove.bg）
