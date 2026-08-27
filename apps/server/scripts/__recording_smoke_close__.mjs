export default async function run({ page, log }) {
  await log("closing smoke popup");
  await page.close();
}
