import { SqlClient } from "@effect/sql"
import { Context, Effect, Layer, Schema } from "effect"
import { CustomerId } from "./Customer.js"
import { IdempotencyKey } from "./IdempotencyKey.js"
import { ProductId } from "./Product.js"

export const SagaLogId = Schema.UUID.pipe(
  Schema.brand("SagaLogId"),
  Schema.annotations({ description: "Saga Identification" })
)
export type SagaLogId = typeof SagaLogId.Type

const SagaLogSchema = Schema.Struct({
  id: SagaLogId,
  customerId: CustomerId,
  idempotencyKey: IdempotencyKey,
  orderId: Schema.optionalWith(Schema.NullOr(Schema.UUID), { default: () => null }),
  productId: ProductId,
  quantity: Schema.Number.annotations({ description: "Quantity" }),
  status: Schema.optionalWith(
    Schema.Literal("STARTED", "IN_PROGRESS", "COMPLETED", "FAILED", "COMPENSATING", "COMPENSATED"),
    { default: () => "STARTED" }
  ).annotations({ description: "Status" }),
  steps: Schema.Array(Schema.Struct({
    compensationStatus: Schema.optionalWith(Schema.Literal("PENDING", "IN_PROGRESS", "COMPLETED", "FAILED"), {
      default: () => "PENDING"
    })
      .annotations({ description: "Compensation Status" }),
    error: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }).annotations({
      description: "Error"
    }),
    name: Schema.Literal("CREATE_ORDER", "PROCESS_PAYMENT", "UPDATE_INVENTORY", "DELIVER_ORDER")
      .annotations({ description: "Step Name" }),
    status: Schema.optionalWith(
      Schema.Literal("PENDING", "IN_PROGRESS", "COMPLETED", "FAILED", "COMPENSATED"),
      { default: () => "PENDING" }
    )
      .annotations({ description: "Status" }),
    timestamp: Schema.optionalWith(Schema.NullOr(Schema.Date), { default: () => null }).annotations({
      description: "Timestamp"
    })
  })),
  totalPrice: Schema.Number.annotations({ description: "Total Price" }),
  createdAt: Schema.optionalWith(Schema.Date, { default: () => new Date() }).annotations({ description: "Created At" })
  // updatedAt: Schema.Date.annotations({ description: "Updated At" }),
  // deletedAt: Schema.NullOr(Schema.Date).annotations({ description: "Delete At" })
}).pipe(
  Schema.annotations({ description: "SagaLog", identifier: "SagaLog" })
)
type SagaLogSchema = typeof SagaLogSchema.Type

export class SagaLog extends Schema.Class<SagaLog>("SagaLog")(SagaLogSchema) {
  static decodeUnknown = Schema.decodeUnknown(SagaLog)
}

export class SagaLogRepository extends Context.Tag("@context/SagaLogRepository")<
  SagaLogRepository,
  {
    readonly findOne: (options: {
      idempotencyKey?: IdempotencyKey
      sagaLogId?: SagaLogId
    }) => Effect.Effect<SagaLog>
    readonly save: (data: SagaLog) => Effect.Effect<SagaLog>
  }
>() {}

export const SagaLogRepositoryLive = Layer.effect(
  SagaLogRepository,
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    yield* sql`
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'saga_status'
  ) THEN
    CREATE TYPE saga_status AS ENUM ('STARTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'COMPENSATING', 'COMPENSATED');
  END IF;
END
$$;
    `.pipe(Effect.catchTag("SqlError", Effect.die))
    yield* sql`
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'step_compensation_status'
  ) THEN
    CREATE TYPE step_compensation_status AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');
  END IF;
END
$$;
    `.pipe(Effect.catchTag("SqlError", Effect.die))
    yield* sql`
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'step_name'
  ) THEN
    CREATE TYPE step_name AS ENUM ('CREATE_ORDER', 'PROCESS_PAYMENT', 'UPDATE_INVENTORY', 'DELIVER_ORDER');
  END IF;
END
$$;
    `.pipe(Effect.catchTag("SqlError", Effect.die))
    yield* sql`
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'step_status'
  ) THEN
    CREATE TYPE step_status AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'COMPENSATED');
  END IF;
END
$$;
    `.pipe(Effect.catchTag("SqlError", Effect.die))
    yield* sql`
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'step_record'
  ) THEN
    CREATE TYPE step_record AS (
      compensation_status step_compensation_status,
      error TEXT,
      name step_name,
      status step_status,
      timestamp TIMESTAMPTZ
    );
  END IF;
END
$$;
    `.pipe(Effect.catchTag("SqlError", Effect.die))
    yield* sql`
CREATE TABLE IF NOT EXISTS tbl_saga_log (
    id UUID PRIMARY KEY,
    customer_id UUID NOT NULL,
    idempotency_key UUID NOT NULL,
    order_id UUID,
    product_id UUID NOT NULL,
    quantity INTEGER NOT NULL,
    status saga_status NOT NULL DEFAULT 'STARTED',
    steps step_record[] NOT NULL DEFAULT '{}',
    total_price DECIMAL(10, 2) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
    `.pipe(Effect.catchTag("SqlError", Effect.die))
    yield* sql`
CREATE INDEX IF NOT EXISTS idx_saga_log_idempotency_key ON tbl_saga_log(idempotency_key);
    `.pipe(Effect.catchTag("SqlError", Effect.die))

    return {
      findOne: ({ idempotencyKey, sagaLogId }) =>
        (idempotencyKey ?
          sql`SELECT * FROM tbl_saga_log WHERE idempotency_key = ${idempotencyKey}` :
          sagaLogId ?
          sql`SELECT * FROM tbl_saga_log WHERE id = ${sagaLogId}` :
          sql`SELECT * FROM tbl_saga_log`)
          .pipe(
            Effect.catchTag("SqlError", Effect.die),
            Effect.flatMap((rows) => Effect.succeed(rows[0])),
            Effect.flatMap((row) => SagaLog.decodeUnknown(row)),
            Effect.catchTag("ParseError", Effect.die)
          ),
      save: (data) =>
        sql`
INSERT INTO tbl_inventory ${sql.insert({ ...data })}
ON CONFLICT (id) 
DO UPDATE SET
    customer_id = EXCLUDED.customer_id,
    idempotency_key = EXCLUDED.idempotency_key,
    order_id = EXCLUDED.order_id,
    product_id = EXCLUDED.product_id,
    quantity = EXCLUDED.quantity,
    status = EXCLUDED.status,
    steps = EXCLUDED.steps,
    total_price = EXCLUDED.total_price,
    created_at = EXCLUDED.created_at
RETURNING *;
`.pipe(
          Effect.catchTag("SqlError", Effect.die),
          Effect.flatMap((rows) => Effect.succeed(rows[0].createSagaLog)),
          Effect.flatMap((row) => SagaLog.decodeUnknown(row)),
          Effect.catchTag("ParseError", Effect.die)
        )
    }
  })
)
