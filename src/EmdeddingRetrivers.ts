import VectorStore from "./VectorStore";

export default class EmbeddingRetrivers {
  private embeddingModel: string;
  private vectorStroe: VectorStore;

  constructor(embeddingModel: string) {
    this.embeddingModel = embeddingModel;
    this.vectorStroe = new VectorStore();
  }

  async embedQuery(query: string): Promise<number[]> {
    const embedding = await this.embed(query);
    return embedding;
  }

  async embedDocument(document: string): Promise<number[]> {
    const embedding = await this.embed(document);
    this.vectorStroe.addItem({
      embedding,
      document,
    });
    return embedding;
  }

  async embed(document: string): Promise<number[]> {
    const respone = await fetch(
      `${process.env.OPENAI_BASE_URL}/embeddings`,
      {
        method: "post",
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
    console.log(data.data[0].embedding);
    return data.data[0].embedding as number[];
  }

  async retrive(query: string, topK: number = 3) {
    const queryEmbedding = await this.embedQuery(query)
    return this.vectorStroe.search(queryEmbedding, topK)
  }
}
