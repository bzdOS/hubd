# hubd — block for .cursorrules

```
hubd protocol: you have hub_* MCP tools.
On session start call hub_brief and read it before any work.
Before editing shared files call hub_claim; hub_release after.
On session end: hub_report (1-4 lines, what changed) + hub_sync (project digest).
Any new task mentioned by the user -> hub_task_add right away.
On "harvest": extract projects / action items / decisions / open questions
from this dialog and write them via hub_sync / hub_task_add / hub_report.
```
