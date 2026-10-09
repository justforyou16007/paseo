# Capture Anti-patterns

When you write something durable — a wiki idea, claim or experiment page — do
not store operational noise. A transient failure written down as a fact gets
loaded into every later session, and the agent cites it against itself long
after the cause is gone.

## Do not capture

| Class | Example (do not store) | Store instead |
| --- | --- | --- |
| Environment-specific failure | "pip failed: No module named torch", "command not found" | The fix, the missing dependency, the correct config |
| Transient error | "got a 429", "CUDA OOM", "connection refused" | Nothing, or the retry/backoff that worked |
| Negative tool-capability claim | "the MCP is broken", "the CLI can't handle long files" | The workaround, or "needs flag X" |
| Single-instance narrative | "in submission s004 the loss spiked at step 300" | Only the class-level rule it implies ("LR > 3e-4 diverges on this model") |

Store how to fix it, never "X can't do Y".

## The helper

`capture-filter.js` flags the mechanical classes: raw error output, transient
errors, and phrasing that declares ARIS tooling broken. It does not flag
research findings about a model or method ("our method fails on long
sequences").

```bash
node .aris/dist/tools/capture-filter.js <file|->   # exit 1 and the reasons when flagged
```

When a note is flagged, rewrite it as the fix or drop it. The single-instance
class is a judgment call the filter cannot make; apply the table yourself.

Taxonomy adapted from NousResearch/hermes-agent's "Do NOT capture" list (MIT).
