/**
 * 内存向量库:暴力 O(n·d) 余弦检索。
 *
 * 为什么够用:演示项目文档量很小(个位数),全量扫描可接受。
 * ---------------------------------------------------------------------------
 * 分层差距:RAG 不在 Pi 参照系内,以下属领域通用实践:
 *   - [持久化] 数据仅存内存,重启即失。应落盘 JSON/SQLite。
 *   - [索引] 文档量上万后,暴力扫描应换向量索引
 *     (hnswlib-node / usearch / sqlite-vec),或至少缓存归一化向量。
 *     阈值无硬标准,取决于延迟预算,量级参考:万级文档 × 768 维
 *     全量扫描在 Node 下约几十毫秒,交互式场景通常已可感知。
 * ---------------------------------------------------------------------------
 */
export interface VectorStoreItem {
  embedding: number[];
  document: string;
}

export default class VectorStore {
  private vectorStore: VectorStoreItem[];

  constructor() {
    this.vectorStore = [];
  }

  async addItem(item: VectorStoreItem) {
    this.vectorStore.push(item);
  }

  /** 检索:全量算相似度 → 降序 → 取前 topK(数据量大时这里是扫描瓶颈)。 */
  async search(queryEmbedding: number[], topK: number = 3) {
    const scored = this.vectorStore.map((item) => ({
      document: item.document,
      score: this.cosineSim(item.embedding, queryEmbedding),
    }));
    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /**
   * 计算两段文本向量的"语义相似度"(余弦相似度)。
   *
   * 思路:把每个文本向量想成一根"方向箭头",
   * 比较两根箭头指向有多接近,结果范围 -1(相反)~ 1(完全相同)。
   *
   * 步骤:
   *   1. 点积 dotProduct——两向量逐维相乘再累加,方向越一致值越大。
   *   2. 模长 magnitude——一根箭头的"长度"(各维平方求和再开方)。
   *   3. 归一化——点积除以两根长度之积,消掉"箭头长短"的影响,
   *      只保留"方向相似度",保证结果落在 [-1, 1]。
   *
   * 返回值意义:
   *   接近 1 = 语义很接近(检索时优先选它)。
   *   接近 0 = 几乎无关。
   *   接近 -1 = 语义相反。
   *
   * TODO(健壮性):任一向量为零向量时,除数为 0,结果是 NaN,
   * 排序行为不确定。应提前返回 0 或过滤该文档。
   */
  private cosineSim(v1: number[], v2: number[]) {
    // 1. 点积:v1 与 v2 同一维度的值相乘,全部累加 → 方向重合度。
    const dotProduct = v1.reduce((acc, val, index) => acc + val * v2[index], 0);

    // 2. v1 的"长度":各维平方求和后开根号。
    const magnitud1 = Math.sqrt(v1.reduce((acc, val) => acc + val * val, 0));

    // 2'. v2 的"长度":同上。
    const magnitud2 = Math.sqrt(v2.reduce((acc, val) => acc + val * val, 0));

    // 3. 归一化:重合度 ÷ 两根长度之积 → 压缩到 [-1,1]。
    return dotProduct / (magnitud1 * magnitud2);
  }
}
