---
name: sct-delete-secret
description: Delete one saved global.sct secret when the user requests removal, with local confirmation of its project and secret ID.
---

# Delete a global.sct secret

Resolve the intended project and secret through `list_secrets` or `describe_secret`.
Use `delete_secret` only for the credential that the user requests to delete.
The deletion cannot be undone.

```json
{"projectId":"00000000-0000-4000-8000-000000000001","secretId":"00000000-0000-4000-8000-000000000002"}
```

CLI equivalent:

```sh
printf '%s' '{"secretId":"00000000-0000-4000-8000-000000000002"}' | sct agent delete_secret --stdin
```

Replace the example IDs with actual metadata IDs.
The CLI example selects the project from the working directory.
The user must approve deletion in the local global.sct window.
Report completion only when the outcome has `status: "completed"` and the expected `deleted` ID.
This operation deletes the saved copy. It does not revoke the credential at its provider or delete external copies.
Stop after refusal, expiry, or failure. Do not repeat deletion automatically.
