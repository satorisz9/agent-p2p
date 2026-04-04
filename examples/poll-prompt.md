agent-p2p の新着タスクを確認しろ。以下の手順で実行:

1. `mcp__agentp2p__task_list` を呼べ
2. status が "accepted" のタスクを抽出
3. 該当タスクがなければ何も出力するな（完全に無言で終了しろ）
4. 該当タスクがあれば:
   a. from と description の内容をユーザーに報告しろ
   b. 報告後、そのタスクを `mcp__agentp2p__task_respond` で action="complete", output={"message":"acknowledged"} として処理済みにしろ
   c. これにより次回ポーリングで同じ通知が重複しない
