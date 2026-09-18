require("dotenv").config();
const { MongoClient } = require("mongodb");
(async () => {
  const c = await MongoClient.connect(process.env.MONGODB_URI);
  const R = c.db("souqi").collection("agent_runs");
  const id = process.argv[2];
  for (let i = 0; i < 40; i++) {
    const r = await R.findOne({ id });
    if (["succeeded","failed","cancelled","partial"].includes(r.status)) { console.log(id, "->", r.status); break; }
    await new Promise(s => setTimeout(s, 5000));
  }
  await c.close();
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
