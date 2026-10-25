0. Containers里面应该安装了opencode, openchamber, and vs code server.

1. Agents should never change any bytes in `./vendors`, it should be updated by ci.

2. `./extensions` is where we mainly work, and this extension is used to installed on latest Openchamber's release. 这里面的任何插件都不要破坏Openchamber原有的功能。

  i. `./extensions/planner`需要integrate了:
    a. calenader and task: 像是gcal和google task可以一起联动的所有功能。
    b. Sunsama 一样可以把Linear issue/Github issues/Email给加入到task里面来的能力。
    c. 可以直接load Linear里面已经保存好的view以及像是linear一样可以临时的去filter一些东西。可以直接修改linear issue的内容。可以直接像是github或者是linear里面一样把task assign给某个agent，然后对应的agent直接开了worktree之后提pr。