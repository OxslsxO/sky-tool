# 证件照功能改进方案

## 问题
禁用 ONNX 模型后，纯算法方案效果很差。

## 推荐方案

### 方案 1：Render 升级 + 模型优化（最佳质量）

**步骤**：

1. **升级 Render 实例**：
   - 从 Free 升级到 **Standard** 计划（$25/月，1GB RAM）
   - 或 **Pro** 计划（$75/月，2GB RAM）

2. **优化内存使用**（已在代码中）：
   - 使用单线程
   - 基本图优化
   - 更长的超时时间

3. **启用模型**：
   ```env
   PHOTO_ID_DISABLE_MODEL=false
   PHOTO_ID_WARM_MODEL=true
   ```

---

### 方案 2：使用第三方抠图 API（推荐）

如果不想升级 Render，可以使用高质量的第三方抠图服务：

#### 选项 A：Remove.bg
- 免费额度：50张/月
- 质量非常好
- API 简单易用

**配置**：
```env
REMOVEBG_API_KEY=your-api-key
```

#### 选项 B：Cloudflare Workers AI
- 价格便宜（$0.01/次）
- 集成方便
- 速度快

**配置**：
```env
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token
```

---

### 方案 3：混合方案（平衡质量和成本）

- 先尝试本地 ONNX 模型
- 如果失败，自动降级到第三方 API
- 如果 API 也失败，再用纯算法

---

## 临时测试

**先测试在 Render 上启用模型是否能工作**：

1. 在 Render 中删除 `PHOTO_ID_DISABLE_MODEL` 环境变量（或设为 `false`）
2. 重新部署
3. 尝试证件照功能
4. 查看日志是否崩溃

如果崩溃，再考虑其他方案。

---

## 我推荐的方案

**先尝试启用模型**，看是否能工作。如果不能工作，再考虑：

- 升级 Render 实例
- 或添加第三方 API 支持

你想先试试启用模型吗？
