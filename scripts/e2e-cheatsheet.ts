import { PERSONAS } from "./e2e-personas.js";

const send = (from: keyof typeof PERSONAS, to: keyof typeof PERSONAS) => {
  const f = PERSONAS[from];
  const t = PERSONAS[to];
  return (
    `  # ${from} → ${to}\n` +
    `  curl -sS -X POST http://127.0.0.1:${f.localPort}/${t.key}/message:send \\\n` +
    `    -H 'Content-Type: application/json' \\\n` +
    `    -d '{"message":{"messageId":"m1","role":"user","parts":[{"kind":"text","text":"hi ${to}"}]}}'`
  );
};

const reply = (who: keyof typeof PERSONAS) => {
  const p = PERSONAS[who];
  return (
    `  # reply on ${who}'s adapter (substitute taskId from the stdout line)\n` +
    `  curl -sS -X POST http://127.0.0.1:${p.adapterPort}/__control/reply/<taskId> \\\n` +
    `    -H 'Content-Type: application/json' \\\n` +
    `    -d '{"text":"reply from ${who}"}'`
  );
};

console.log("### Send a message (from a 3rd pane)\n");
console.log(send("alice", "bob"));
console.log();
console.log(send("bob", "alice"));
console.log("\n### Reply (run in the pane that got the inbound line, or any 3rd pane)\n");
console.log(reply("alice"));
console.log();
console.log(reply("bob"));
console.log();
