/* 跨页面共享的数据缓存与基础拉取。各页面只在需要时拉取并写入这里。 */
import { api } from "./api.js";

export const store = {
  keys: [],        // 密钥列表（当前角色的可见范围：管理员全量 / 普通用户自己名下）
  upstreams: [],   // 上游（管理员全量 / 普通用户仅其密钥可达且已裁剪）
  chatKeys: [],    // 对话页下拉可选密钥
};

export async function loadKeys() {
  try {
    const res = await api("/admin/keys");
    if (!res.ok) throw new Error("加载失败");
    const data = await res.json();
    store.keys = data;
    return data;
  } catch (e) { return []; }
}

export async function loadUpstreams() {
  try {
    const res = await api("/admin/upstreams");
    if (!res.ok) throw new Error("加载失败");
    const data = await res.json();
    store.upstreams = data;
    return data;
  } catch (e) { return []; }
}

export function getUpstreamName(id) {
  if (!id) return "默认";
  const up = store.upstreams.find((u) => u.id === id);
  return up ? up.name : "未知";
}
