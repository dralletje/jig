export default class Store<T extends { id: string }> {
  private readonly items = new Map<string, T>();

  add(item: T) {
    this.items.set(item.id, item);
    return item;
  }

  get(id: string) {
    return this.items.get(id);
  }

  all() {
    return [...this.items.values()];
  }
}
