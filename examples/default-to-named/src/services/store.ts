class Store {
  private readonly items = new Map<string, number>();

  put(key: string, value: number): void {
    this.items.set(key, value);
  }
}

export { Store as default };
