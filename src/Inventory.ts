import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpMiddleware,
  HttpServer,
  OpenApi
} from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import * as HttpApiScalar from "@effect/platform/HttpApiScalar"
import * as HttpApiSwagger from "@effect/platform/HttpApiSwagger"
import { SqlClient } from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import { Console, Context, Effect, flow, Layer, Logger, LogLevel, Schema, String } from "effect"
import * as http from "node:http"
import { v7 as uuidv7 } from "uuid"
import { IdempotencyKey } from "./IdempotencyKey.js"
import { OrderId } from "./Order.js"
import { Outbox, OutboxId, OutboxRepository, OutboxRepositoryLive } from "./Outbox.js"
import { ProductId } from "./Product.js"
import { SagaLog, SagaLogId, SagaLogRepository, SagaLogRepositoryLive } from "./SagaLog.js"

export const InventoryId = Schema.UUID.pipe(
  Schema.brand("InventoryId"),
  Schema.annotations({ description: "Inventory Identification" })
)
export type InventoryId = typeof InventoryId.Type

const InventorySchemaStruct = Schema.Struct({
  id: InventoryId,
  compensationKey: Schema.optionalWith(Schema.NullOr(IdempotencyKey), { default: () => null }),
  lastIdempotencyKey: Schema.optionalWith(Schema.NullOr(IdempotencyKey), { default: () => null }),
  orderId: Schema.optionalWith(Schema.NullOr(OrderId), { default: () => null }),
  productId: Schema.optionalWith(Schema.NullOr(ProductId), { default: () => null }),
  quantity: Schema.Number.annotations({ description: "Quantity" }),
  reservedQuantity: Schema.optionalWith(Schema.Number.annotations({ description: "Reserved Quantity" }), {
    default: () => 0
  })
  // createdAt: Schema.optionalWith(Schema.Date, { default: () => new Date() }).annotations({ description: "Created At" })
  // updatedAt: Schema.Date.annotations({ description: "Updated At" }),
  // deletedAt: Schema.NullOr(Schema.Date).annotations({ description: "Delete At" })
}).pipe(
  Schema.annotations({ description: "InventoryData", identifier: "InventoryData" })
)
type InventorySchemaStruct = typeof InventorySchemaStruct.Type

class Inventory extends Schema.Class<Inventory>("Inventory")(InventorySchemaStruct) {
  static decodeUnknown = Schema.decodeUnknown(InventorySchemaStruct)
}

class InventoryRepository extends Context.Tag("@context/InventoryRepository")<
  InventoryRepository,
  {
    readonly findOne: (options: {
      compensationOrder?: {
        compensationKey: IdempotencyKey
        orderId: OrderId
      }
      lastIdempotencyKey?: IdempotencyKey
      productId?: ProductId
    }) => Effect.Effect<Inventory>
    readonly save: (data: Inventory) => Effect.Effect<Inventory>
  }
>() {}

const InventoryRepositoryLive = Layer.effect(
  InventoryRepository,
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    yield* sql`
CREATE TABLE tbl_inventory (
    id UUID PRIMARY KEY,
    compensation_key UUID,
    last_idempotency_key UUID,
    order_id UUID,
    product_id UUID,
    quantity INTEGER NOT NULL CHECK (quantity >= 0),
    reserved_quantity INTEGER DEFAULT 0 CHECK (reserved_quantity >= 0),

    INDEX idx_inventory_compensation_key_order_id ON (compensation_key, order_id) WHERE compensation_key IS NOT NULL AND order_id IS NOT NULL,
    INDEX idx_inventory_last_idempotency_key ON (last_idempotency_key),
    INDEX idx_inventory_product_id ON (product_id),
    
    CONSTRAINT reserved_quantity_valid CHECK (reserved_quantity <= quantity)
);
    `

    return {
      findOne: ({ compensationOrder, lastIdempotencyKey, productId }) =>
        (compensationOrder ?
          sql`SELECT * FROM tbl_inventory WHERE compensation_key = ${compensationOrder.compensationKey} AND order_id = ${compensationOrder.orderId} LIMIT 1` :
          lastIdempotencyKey ?
          sql`SELECT * FROM tbl_inventory WHERE last_idempotency_key = ${lastIdempotencyKey} LIMIT 1` :
          productId ?
          sql`SELECT * FROM tbl_inventory WHERE product_id = ${productId} LIMIT 1` :
          sql`SELECT * FROM tbl_inventory LIMIT 1`).pipe(
            Effect.catchTag("SqlError", Effect.die),
            Effect.flatMap((rows) => Effect.succeed(rows[0])),
            Effect.flatMap((row) => Inventory.decodeUnknown(row)),
            Effect.catchTag("ParseError", Effect.die)
          ),
      save: (data) =>
        sql`
INSERT INTO tbl_inventory ${sql.insert({ ...data })}
ON CONFLICT (id) 
DO UPDATE SET
    compensation_key = EXCLUDED.compensation_key,
    last_idempotency_key = EXCLUDED.last_idempotency_key,
    order_id = EXCLUDED.order_id,
    product_id = EXCLUDED.product_id,
    quantity = EXCLUDED.quantity,
    reserved_quantity = EXCLUDED.reserved_quantity
RETURNING *;
`.pipe(
          Effect.catchTag("SqlError", Effect.die),
          Effect.flatMap((rows) => Effect.succeed(rows[0])),
          Effect.flatMap((row) => Inventory.decodeUnknown(row)),
          Effect.catchTag("ParseError", Effect.die)
        )
    }
  })
)

const InventoryUpdateRequest = Schema.Struct({
  orderId: OrderId,
  productId: ProductId,
  quantity: Schema.Number.annotations({ description: "Quantity" }),
  sagaLogId: SagaLogId
}).pipe(
  Schema.annotations({ description: "Inventory Update Request", identifier: "InventoryUpdateRequest" })
)
type InventoryUpdateRequest = typeof InventoryUpdateRequest.Type

const InventoryCompensateRequest = Schema.Struct({
  orderId: OrderId,
  productId: ProductId,
  quantity: Schema.Number.annotations({ description: "Quantity" }),
  sagaLogId: SagaLogId
}).pipe(
  Schema.annotations({ description: "Inventory Compensate Request", identifier: "InventoryCompensateRequest" })
)
type InventoryCompensateRequest = typeof InventoryCompensateRequest.Type

const InventoryInitializeRequest = Schema.Struct({
  productId: ProductId,
  quantity: Schema.Number.annotations({ description: "Quantity" })
}).pipe(
  Schema.annotations({ description: "Inventory Compensate Request", identifier: "InventoryInitializeRequest" })
)
type InventoryInitializeRequest = typeof InventoryInitializeRequest.Type

class InventoryHttpApiGroup extends HttpApiGroup.make("inventory")
  .add(
    HttpApiEndpoint.post("update", "/update")
      .addSuccess(Schema.Struct({}))
      .setHeaders(Schema.Struct({ "idempotency-key": IdempotencyKey }))
      .setPayload(InventoryUpdateRequest)
      .annotate(OpenApi.Description, "Inventory Update")
      .annotate(OpenApi.Summary, "Inventory Update")
  )
  .add(
    HttpApiEndpoint.post("compensate", "/compensate")
      .addSuccess(Schema.Struct({}))
      .setHeaders(Schema.Struct({ "idempotency-key": IdempotencyKey }))
      .setPayload(InventoryCompensateRequest)
      .annotate(OpenApi.Description, "Inventory Compensate")
      .annotate(OpenApi.Summary, "Inventory Compensate")
  )
  .add(
    HttpApiEndpoint.post("initialize", "/initialize")
      .addSuccess(Schema.Struct({}))
      // .setHeaders(Schema.Struct({ "idempotency-key": IdempotencyKey }))
      .setPayload(InventoryInitializeRequest)
      .annotate(OpenApi.Description, "Inventory Compensate")
      .annotate(OpenApi.Summary, "Inventory Compensate")
  )
  .add(
    HttpApiEndpoint.get("get", "/:productId")
      .addSuccess(Schema.Struct({}))
      .setPath(Schema.Struct({ productId: ProductId }))
      .annotate(OpenApi.Description, "Inventory Get")
      .annotate(OpenApi.Summary, "Inventory Get")
  )
  .annotate(OpenApi.Description, "Manage Inventory")
  .annotate(OpenApi.Summary, "Manage Inventory")
  .annotate(OpenApi.Title, "Inventory")
  .prefix("/inventory")
{}

const Api = HttpApi.make("api")
  .add(InventoryHttpApiGroup)
  .annotate(OpenApi.Description, "Manage Inventory API")
  .annotate(OpenApi.Summary, "Manage Inventory API")
  .annotate(OpenApi.Title, "Inventory API")
  .prefix("/api/v1")

const InventoryHttpApiLive = HttpApiBuilder.group(
  Api,
  "inventory",
  (handlers) =>
    Effect.gen(function*() {
      const inventoryRepository = yield* InventoryRepository
      const sagaLogRepository = yield* SagaLogRepository
      const outboxRepository = yield* OutboxRepository

      return handlers.handle(
        "update",
        ({ headers: { "idempotency-key": idempotencyKey }, payload: { orderId, productId, quantity, sagaLogId } }) =>
          Effect.gen(function*() {
            yield* Console.log(
              `[Inventory Service] Inventory update ${{ idempotencyKey, orderId, productId, quantity, sagaLogId }}`
            )
            const existingInventoryLog = yield* inventoryRepository.findOne({
              lastIdempotencyKey: idempotencyKey
            })
            if (existingInventoryLog) {
              yield* Console.log(`[Inventory Service] Inventory already updated with key: ${idempotencyKey}`)
              return {
                data: existingInventoryLog,
                message: "Inventory already updated",
                success: true
              }
            }
            // Get saga log to track progress
            let sagaLog = yield* sagaLogRepository.findOne({ sagaLogId })
            // Execute inventory update without transaction
            let inventory = yield* inventoryRepository.findOne({ productId })
            if (!inventory) {
              // Initialize inventory with default stock of 100 units
              inventory = new Inventory({
                id: InventoryId.make(uuidv7()),
                productId,
                quantity: 100,
                reservedQuantity: 0
              })
              yield* inventoryRepository.save(inventory)
              yield* Console.log(`[Inventory Service] Initialized inventory for product ${productId} with 100 units`)
            }
            // Update saga log
            sagaLog = new SagaLog({
              ...sagaLog,
              steps: sagaLog.steps.map((step) =>
                step.name === "UPDATE_INVENTORY"
                  ? { ...step, status: "IN_PROGRESS", timestamp: new Date() }
                  : step
              )
            })
            yield* sagaLogRepository.save(sagaLog)
            // Check if there's enough inventory
            if (inventory.quantity - inventory.reservedQuantity < quantity) {
              yield* Console.log(`[Inventory Service] Insufficient inventory for product: ${productId}`)
              // Update saga log
              sagaLog = new SagaLog({
                ...sagaLog,
                steps: sagaLog.steps.map((step) =>
                  step.name === "UPDATE_INVENTORY"
                    ? { ...step, status: "FAILED", error: "Insufficient inventory" }
                    : step
                )
              })
              yield* sagaLogRepository.save(sagaLog)
              // throw new Error("Insufficient inventory")
              return {
                error: "Insufficient inventory",
                message: "Error updating inventory",
                success: false
              }
            }
            // Update inventory - reduce available quantity and increase reserved
            inventory = new Inventory({
              ...inventory,
              quantity: inventory.quantity - quantity,
              reservedQuantity: inventory.reservedQuantity + quantity,
              lastIdempotencyKey: idempotencyKey
            })
            yield* inventoryRepository.save(inventory)
            yield* Console.log(`[Inventory Service] Inventory updated for product: ${productId}`)
            // Update saga log
            // inventoryStep.status = "COMPLETED"
            sagaLog = new SagaLog({
              ...sagaLog,
              steps: sagaLog.steps.map((step) =>
                step.name === "UPDATE_INVENTORY"
                  ? { ...step, status: "COMPLETED" }
                  : step
              )
            })
            yield* sagaLogRepository.save(sagaLog)
            // Write shipping event to Outbox
            yield* Console.log(`[Inventory Service] Writing shipping event to Outbox`)
            const outboxEntry = new Outbox({
              id: OutboxId.make(uuidv7()),
              aggregateId: OrderId.make(orderId.toString()),
              eventType: "InventoryUpdated",
              payload: {
                customerId: sagaLog.customerId || "unknown",
                orderId,
                sagaLogId
              },
              targetService: "shipping",
              targetEndpoint: "/shipments/deliver-order",
              isPublished: false
            })
            yield* outboxRepository.save(outboxEntry)
            yield* Console.log(`[Inventory Service] Shipping event written to Outbox: ${outboxEntry.id}`)
            yield* Console.log(`[Inventory Service] Saga will be completed when Shipping processes event\n`)

            // return { inventory, outboxEntry }
            return {
              data: inventory,
              message: "Inventory update successfully",
              success: true
            }
          })
      ).handle(
        "compensate",
        ({ headers: { "idempotency-key": idempotencyKey }, payload: { orderId, productId, quantity, sagaLogId } }) =>
          Effect.gen(function*() {
            yield* Console.log(
              `[Inventory Service] Inventory compensate ${{ idempotencyKey, orderId, productId, quantity, sagaLogId }}`
            )
            // Check if already compensated
            let inventory = yield* inventoryRepository.findOne({
              compensationOrder: { compensationKey: idempotencyKey, orderId }
            })
            if (inventory) {
              yield* Console.log(`[Inventory Service] Inventory already compensated with key: ${idempotencyKey}`)
              return {
                data: inventory,
                message: "Inventory already compensated",
                success: true
              }
            }
            inventory = yield* inventoryRepository.findOne({ productId })
            if (!inventory) {
              // throw new Error("Inventory not found")
              return {
                message: "Inventory not found",
                success: false
              }
            }
            // Restore inventory
            inventory = new Inventory({
              ...inventory,
              compensationKey: idempotencyKey,
              orderId,
              quantity: inventory.quantity + quantity,
              reservedQuantity: Math.max(0, inventory.reservedQuantity - quantity)
            })
            yield* inventoryRepository.save(inventory)
            yield* Console.log(`[Inventory Service] Inventory compensated for product: ${productId}`)

            return {
              data: inventory,
              message: "Inventory compensated successfully",
              success: true
            }
          })
      ).handle(
        "initialize",
        ({ payload: { productId, quantity } }) =>
          Effect.gen(function*() {
            yield* Console.log(
              `[Inventory Service] Inventory initialize ${{ productId, quantity }}`
            )
            let inventory = yield* inventoryRepository.findOne({ productId })
            if (!inventory) {
              inventory = new Inventory({
                id: InventoryId.make(uuidv7()),
                productId,
                quantity,
                reservedQuantity: 0
              })
            } else {
              inventory = new Inventory({
                ...inventory,
                quantity: inventory.quantity + quantity
              })
            }
            yield* inventoryRepository.save(inventory)

            return {
              data: inventory,
              message: "Inventory initialized",
              success: true
            }
          })
      ).handle("get", ({ path: { productId } }) =>
        Effect.gen(function*() {
          yield* Console.log(
            `[Inventory Service] Inventory initialize ${{ productId }}`
          )
          const inventory = yield* inventoryRepository.findOne({ productId })
          if (!inventory) {
            // throw new Error("Inventory not found")
            return {
              message: "Inventory not found",
              success: false
            }
          }

          return {
            data: inventory,
            message: "",
            success: true
          }
        }))
    })
)

const PgLive = PgClient.layer({
  database: "effect_pg_dev",
  transformQueryNames: String.camelToSnake,
  transformResultNames: String.snakeToCamel
})

const ApplicationLayer = InventoryHttpApiLive.pipe(
  Layer.provide(
    Layer.provideMerge(
      Layer.mergeAll(
        InventoryRepositoryLive,
        OutboxRepositoryLive,
        SagaLogRepositoryLive
      ),
      PgLive
    )
  )
)

const ApiLive = HttpApiBuilder.api(Api)
  .pipe(Layer.provide(ApplicationLayer))

const gracefulShutdown = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  Layer.scopedDiscard(
    Effect.addFinalizer(() => Effect.logInfo("Graceful Shutdown"))
  ).pipe(
    Layer.provideMerge(layer)
  )

HttpApiBuilder.serve(flow(
  HttpMiddleware.cors({
    allowedOrigins: [
      "http://127.0.0.1:3000",
      "http://127.0.0.1:3001",
      "http://127.0.0.1:3002",
      "http://127.0.0.1:3003",
      "http://127.0.0.1:3004"
    ],
    allowedMethods: ["DELETE", "GET", "OPTIONS", "PATCH", "POST", "PUT"],
    allowedHeaders: ["authorization", "b3", "content-type", "idempotency-key", "traceparent"],
    exposedHeaders: ["authorization", "content-type"],
    credentials: true,
    maxAge: 86400
  }),
  HttpMiddleware.logger
)).pipe(
  // Layer.provide(NodeSdkLive),
  Layer.provide(HttpApiBuilder.middlewareOpenApi({ path: "/openapi.json" })),
  Layer.provide(HttpApiScalar.layer({ path: "/reference" })),
  Layer.provide(HttpApiSwagger.layer({ path: "/doc" })),
  Layer.provide(ApiLive),
  Layer.provide(Logger.minimumLogLevel(LogLevel.Debug)),
  HttpServer.withLogAddress,
  Layer.provide(NodeHttpServer.layer(http.createServer, { port: 3003 })),
  gracefulShutdown,
  Layer.launch,
  NodeRuntime.runMain
)
