export default async function sendReceipt(to: string, body: string): Promise<boolean> {
  return to.includes("@") && body.length > 0;
}
