import { Schema } from "effect"

export const IdempotencyKey = Schema.UUID.pipe(
  Schema.brand("idempotencyKey"),
  Schema.annotations({ description: "Idempotency Key" })
)
export type IdempotencyKey = typeof IdempotencyKey.Type
