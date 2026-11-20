/**
 * Embedding 检索器:文本 → 向量,并维护向量库。
 *
 * 为什么直接 fetch 而非用 openai SDK:教学目的——演示 /embeddings
 * 端点的裸 HTTP 调用,看清请求与响应的结构。
 * (openai SDK 已是项目依赖,用 SDK 并不会新增依赖。)
 *
 * TODO(分层差距 · RAG 侧属领域通用实践,不在 Pi 参照系内):
 *  - 无错误处理:response 非 2xx 时 respone.json() 抛出的错误难以定位。
 *  - 每次启动全量 embed 且无缓存,详见 index.ts 的持久化 TODO。
 *  - 类名 EmdeddingRetrivers 是拼写错误,应为 EmbeddingRetrievers。
 */
import VectorStore from "./VectorStore";

export default class EmbeddingRetrivers {
  private embeddingModel: string;
  private vectorStroe: VectorStore; // TODO: 拼写错误,应为 vectorStore

  constructor(embeddingModel: string) {
    this.embeddingModel = embeddingModel;
    this.vectorStroe = new VectorStore();
  }

  /** 查询向量化:只嵌入,不入库(查询目标不属于知识库)。 */
  async embedQuery(query: string): Promise<number[]> {
    const embedding = await this.embed(query);
    return embedding;
  }

  /** 文档入库:嵌入后存入向量库,供后续检索。 */
  async embedDocument(document: string): Promise<number[]> {
    const embedding = await this.embed(document);
    this.vectorStroe.addItem({
      embedding,
      document,
    });
    return embedding;
  }

  /** 调用 embedding 模型,把文本转成 768 维向量。 */
  async embed(document: string): Promise<number[]> {
    const respone = await fetch(
      `${process.env.OPENAI_BASE_URL}/embeddings`,
      {
        method: "post", // TODO: 拼写应为 "POST"
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.embeddingModel,
          input: document,
        }),
      },
    );

    const data = await respone.json();
    // TODO: 调试日志,生产应删除(每次打印 768 维数组会刷屏)。
    console.log(data.data[0].embedding);
    return data.data[0].embedding as number[];
  }

  /** 检索:把 query 向量化,在向量库中找最相似的 topK 个文档。 */
  async retrive(query: string, topK: number = 3) {
    const queryEmbedding = await this.embedQuery(query)
    return this.vectorStroe.search(queryEmbedding, topK)
  }
}
