import { SqlClient } from "@effect/sql"
import { Context, Effect, Layer, Schema } from "effect"
import { CustomerId } from "./Customer.js"
import { IdempotencyKey } from "./IdempotencyKey.js"
import { OrderId } from "./Order.js"
import { ProductId } from "./Product.js"

export const SagaLogId = Schema.UUID.pipe(
  Schema.brand("SagaLogId"),
  Schema.annotations({ description: "Saga Identification" })
)
export type SagaLogId = typeof SagaLogId.Type

const SagaLogSchema = Schema.Struct({
  customerId: CustomerId,
  idempotencyKey: IdempotencyKey,
  orderId: Schema.optionalWith(Schema.NullOr(OrderId), { default: () => null }),
  productId: ProductId,
  quantity: Schema.Number.annotations({ description: "Quantity" }),
  sagaLogId: SagaLogId,
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
    status: Schema.optionalWith(
      Schema.Literal("PENDING", "IN_PROGRESS", "COMPLETED", "FAILED", "COMPENSATED"),
      { default: () => "PENDING" }
    )
      .annotations({ description: "Status" }),
    stepName: Schema.Literal("CREATE_ORDER", "PROCESS_PAYMENT", "UPDATE_INVENTORY", "DELIVER_ORDER")
      .annotations({ description: "Step Name" }),
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
-- Create enum types for status fields
CREATE TYPE saga_status AS ENUM (
    'STARTED',
    'IN_PROGRESS',
    'COMPLETED',
    'FAILED',
    'COMPENSATING',
    'COMPENSATED'
);
    `
    yield* sql`
CREATE TYPE step_status AS ENUM (
    'PENDING',
    'IN_PROGRESS',
    'COMPLETED',
    'FAILED',
    'COMPENSATED'
);
    `
    yield* sql`
CREATE TYPE compensation_status AS ENUM (
    'PENDING',
    'IN_PROGRESS',
    'COMPLETED',
    'FAILED'
);
    `
    yield* sql`
CREATE TYPE step_name AS ENUM (
    'CREATE_ORDER',
    'PROCESS_PAYMENT',
    'UPDATE_INVENTORY',
    'DELIVER_ORDER'
);
    `
    yield* sql`
-- Create the main tbl_saga_log table
CREATE TABLE tbl_saga_log (
    -- Primary key
    saga_log_id UUID PRIMARY KEY,
    
    -- Foreign key references (assuming these tables exist)
    customer_id UUID NOT NULL,
    idempotency_key UUID NOT NULL,
    product_id UUID NOT NULL,
    
    -- Optional foreign key
    order_id UUID,
    
    -- Scalar fields
    quantity INTEGER NOT NULL,
    total_price DECIMAL(10, 2) NOT NULL,
    status saga_status NOT NULL DEFAULT 'STARTED',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    -- Timestamps for tracking
    -- updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- deleted_at TIMESTAMP WITH TIME ZONE,
    
    -- Constraints
    UNIQUE(idempotency_key),
    
    -- Foreign key constraints (adjust table names as needed)
    -- CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES customers(customer_id),
    -- CONSTRAINT fk_product FOREIGN KEY (product_id) REFERENCES products(product_id),
    -- CONSTRAINT fk_order FOREIGN KEY (order_id) REFERENCES orders(order_id)
    
    -- Indexes for common queries
    INDEX idx_saga_log_customer_id (customer_id),
    INDEX idx_saga_log_idempotency_key (idempotency_key),
    INDEX idx_saga_log_status (status),
    INDEX idx_saga_log_created_at (created_at)
);
    `
    yield* sql`
-- Create the saga_steps table for the steps array
CREATE TABLE tbl_saga_step (
    step_id SERIAL PRIMARY KEY,
    saga_log_id UUID NOT NULL,
    step_name step_name NOT NULL,
    status step_status NOT NULL DEFAULT 'PENDING',
    compensation_status compensation_status NOT NULL DEFAULT 'PENDING',
    error TEXT,
    timestamp TIMESTAMP WITH TIME ZONE,
    
    -- Constraints
    CONSTRAINT fk_saga_log 
        FOREIGN KEY (saga_log_id) 
        REFERENCES tbl_saga_log(saga_log_id) 
        ON DELETE CASCADE,
    
    -- Ensure each step name appears only once per saga
    UNIQUE(saga_log_id, step_name),
    
    -- Indexes
    INDEX idx_saga_step_saga_log_id (saga_log_id),
    INDEX idx_saga_step_status (status)
);
    `
    yield* sql`
-- Create a view to get saga logs with their steps as JSON
CREATE VIEW saga_log_with_steps AS
SELECT 
    sl.*,
    COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'stepName', ss.step_name,
                'status', ss.status,
                'compensationStatus', ss.compensation_status,
                'error', ss.error,
                'timestamp', ss.timestamp
            ) ORDER BY ss.step_name
        ),
        '[]'::jsonb
    ) as steps
FROM tbl_saga_log sl
LEFT JOIN tbl_saga_step ss ON sl.saga_log_id = ss.saga_log_id
GROUP BY sl.saga_log_id;
    `
    //     yield* sql`
    // -- Create function to update updated_at timestamp
    // CREATE OR REPLACE FUNCTION update_updated_at_column()
    // RETURNS TRIGGER AS $$
    // BEGIN
    //     NEW.updated_at = CURRENT_TIMESTAMP;
    //     RETURN NEW;
    // END;
    // $$ language 'plpgsql';
    //     `
    //     yield* sql`
    // -- Create trigger for updated_at
    // CREATE TRIGGER update_saga_log_updated_at
    //     BEFORE UPDATE ON tbl_saga_log
    //     FOR EACH ROW
    //     EXECUTE FUNCTION update_updated_at_column();
    //     `
    yield* sql`
-- Create function to insert a new saga log with steps
CREATE OR REPLACE FUNCTION create_saga_log(
    p_saga_log_id UUID,
    p_customer_id UUID,
    p_idempotency_key UUID,
    p_product_id UUID,
    p_quantity INTEGER,
    p_total_price DECIMAL,
    p_order_id UUID DEFAULT NULL,
    p_status saga_status DEFAULT 'STARTED'
) RETURNS UUID AS $$
DECLARE
    step_names step_name[] := ARRAY['CREATE_ORDER', 'PROCESS_PAYMENT', 'UPDATE_INVENTORY', 'DELIVER_ORDER']::step_name[];
    step_name_val step_name;
BEGIN
    -- Insert the main saga log
    INSERT INTO tbl_saga_log (
        saga_log_id,
        customer_id,
        idempotency_key,
        product_id,
        quantity,
        total_price,
        order_id,
        status
    ) VALUES (
        p_saga_log_id,
        p_customer_id,
        p_idempotency_key,
        p_product_id,
        p_quantity,
        p_total_price,
        p_order_id,
        p_status
    );
    
    -- Insert default steps for the saga
    FOREACH step_name_val IN ARRAY step_names
    LOOP
        INSERT INTO tbl_saga_step (
            saga_log_id,
            step_name
        ) VALUES (
            p_saga_log_id,
            step_name_val
        );
    END LOOP;
    
    RETURN p_saga_log_id;
END;
$$ LANGUAGE plpgsql;
    `
    yield* sql`
-- Create function to update a step's status
CREATE OR REPLACE FUNCTION update_saga_step(
    p_saga_log_id UUID,
    p_step_name step_name,
    p_status step_status DEFAULT NULL,
    p_compensation_status compensation_status DEFAULT NULL,
    p_error TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
    UPDATE tbl_saga_step
    SET 
        status = COALESCE(p_status, status),
        compensation_status = COALESCE(p_compensation_status, compensation_status),
        error = COALESCE(p_error, error),
        timestamp = CASE 
            WHEN p_status IS NOT NULL OR p_compensation_status IS NOT NULL 
            THEN CURRENT_TIMESTAMP 
            ELSE timestamp 
        END
    WHERE 
        saga_log_id = p_saga_log_id 
        AND step_name = p_step_name;
    
    -- Update the main saga log's updated_at
    --UPDATE tbl_saga_log
    --SET updated_at = CURRENT_TIMESTAMP
    --WHERE saga_log_id = p_saga_log_id;
END;
$$ LANGUAGE plpgsql;
    `

    return {
      findOne: ({ idempotencyKey, sagaLogId }) =>
        (idempotencyKey ?
          sql`SELECT * FROM saga_log_with_steps WHERE idempotency_key = ${idempotencyKey}` :
          sagaLogId ?
          sql`SELECT * FROM saga_log_with_steps WHERE saga_log_id = ${sagaLogId}` :
          sql`SELECT * FROM saga_log_with_steps`)
          .pipe(
            Effect.catchTag("SqlError", Effect.die),
            Effect.flatMap((rows) => Effect.succeed(rows[0])),
            Effect.flatMap((row) => SagaLog.decodeUnknown(row)),
            Effect.catchTag("ParseError", Effect.die)
          ),
      save: (data) =>
        sql`SELECT create_saga_log(${data.sagaLogId}, ${data.customerId}, ${data.idempotencyKey}, ${data.productId}, ${data.quantity}, ${data.totalPrice}, ${data.orderId}, ${data.status})`
          .pipe(
            Effect.catchTag("SqlError", Effect.die),
            Effect.flatMap((rows) => Effect.succeed(rows[0].createSagaLog)),
            Effect.flatMap((row) => SagaLog.decodeUnknown(row)),
            Effect.catchTag("ParseError", Effect.die)
          )
    }
  })
)
