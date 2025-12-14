import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import type { Fiber } from "effect"
import { Config, Console, Context, Duration, Effect, Layer, Schedule, Schema, String } from "effect"
import { OrderId } from "./Order.js"

export const EventId = Schema.UUID.pipe(
  Schema.brand("EventId"),
  Schema.annotations({ description: "Event Identification" })
)
export type EventId = typeof EventId.Type

const OutboxSchema = Schema.Struct({
  aggregateId: OrderId,
  eventId: EventId,
  eventType: Schema.Literal(
    "OrderCreated",
    "PaymentProcessed",
    "PaymentFailed",
    "InventoryUpdated",
    "InventoryFailed",
    "OrderShipped",
    "OrderDelivered",
    "OrderCompensated"
  ).annotations({ description: "Event Type" }),
  isPublished: Schema.optionalWith(Schema.Boolean, { default: () => false }).annotations({ description: "Published" }),
  lastError: Schema.optionalWith(Schema.NullOr(Schema.String).annotations({ description: "Last Error" }), {
    default: () => null
  }),
  maxRetries: Schema.optionalWith(Schema.Number, { default: () => 3 }).annotations({ description: "Max Retries" }),
  payload: Schema.Unknown,
  publishAttempts: Schema.optionalWith(Schema.Number.annotations({ description: "Publish Attempts" }), {
    default: () => 0
  }),
  publishedAt: Schema.optionalWith(Schema.NullOr(Schema.Date).annotations({ description: "Published At" }), {
    default: () => null
  }),
  targetEndpoint: Schema.String.annotations({ description: "Target Endpoint" }),
  targetService: Schema.Literal("payment", "inventory", "shipping", "order")
    .annotations({ description: "Target Service" }),
  createdAt: Schema.optionalWith(Schema.Date, { default: () => new Date() }).annotations({ description: "Created At" })
  // updatedAt: Schema.Date.annotations({ description: "Updated At" }),
  // deletedAt: Schema.NullOr(Schema.Date).annotations({ description: "Delete At" })
}).pipe(
  Schema.annotations({ description: "Outbox", identifier: "Outbox" })
)
type ServiceSchema = typeof OutboxSchema.Type

export class Outbox extends Schema.Class<Outbox>("Outbox")(OutboxSchema) {
  static decodeUnknown = Schema.decodeUnknown(Outbox)
}

class OutboxRepository extends Context.Tag("@context/OutboxRepository")<
  OutboxRepository,
  {
    readonly findUnpublished: (options: {
      batchSize: number
    }) => Effect.Effect<Array<Outbox>, Error>
    readonly save: (data: Outbox) => Effect.Effect<Outbox, Error>
  }
>() {}

const OutboxRepositoryLive = Layer.effect(
  OutboxRepository,
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    yield* sql`
CREATE TABLE tbl_outbox (
    -- Primary key
    id SERIAL PRIMARY KEY,
    
    -- Required fields
    aggregate_id UUID NOT NULL,  -- Assuming OrderId is also UUID
    event_id UUID NOT NULL,
    event_type VARCHAR(50) NOT NULL 
        CHECK (eventType IN (
            'OrderCreated',
            'PaymentProcessed',
            'PaymentFailed',
            'InventoryUpdated',
            'InventoryFailed',
            'OrderShipped',
            'OrderDelivered',
            'OrderCompensated'
        )),
    payload JSONB NOT NULL,  -- or JSON, depending on your DB
    target_endpoint VARCHAR(255) NOT NULL,
    target_service VARCHAR(50) NOT NULL 
        CHECK (target_service IN ('payment', 'inventory', 'shipping', 'order')),
    
    -- Optional fields with defaults
    is_published BOOLEAN NOT NULL DEFAULT FALSE,
    last_error TEXT,
    max_retries INTEGER NOT NULL DEFAULT 3,
    publish_attempts INTEGER NOT NULL DEFAULT 0,
    published_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    -- Indexes for better performance
    INDEX idx_outbox_is_published (is_pblished),
    INDEX idx_outbox_target_service (target_service),
    INDEX idx_outbox_created_at (created_at),
    INDEX idx_outbox_event_type (event_type),
    
    -- Unique constraint
    CONSTRAINT uq_outbox_event_id UNIQUE (event_id)

    -- Reference to Orders table if it exists
    -- aggregateId UUID NOT NULL REFERENCES tbl_order(id),
);
    `
    yield* sql`
CREATE INDEX idx_outbox_unpublished_service 
ON tbl_outbox (target_service, is_published) 
WHERE is_published = FALSE;
    `

    return {
      findUnpublished: ({ batchSize }) =>
        sql`SELECT * FROM tbl_outbox WEHRE is_published = FALSE LIMIT ${batchSize}`.pipe(
          Effect.catchTag("SqlError", Effect.die),
          Effect.flatMap((outboxs) => Effect.all(outboxs.map((outbox) => Outbox.decodeUnknown(outbox)))),
          Effect.catchTag("ParseError", Effect.die)
        ),
      save: (data) =>
        sql`INSERT INTO tbl_outbox ${sql.insert({ ...data })} RETURNING *`.pipe(
          Effect.catchTag("SqlError", Effect.die),
          Effect.flatMap((rows) => Effect.succeed(rows[0])),
          Effect.flatMap((row) => Outbox.decodeUnknown(row)),
          Effect.catchTag("ParseError", Effect.die)
        )
    }
  })
)

class ConfigService extends Context.Tag("@context/ConfigService")<
  ConfigService,
  {
    readonly batchSize: number
    readonly maxRetries: number
    readonly pollIntervalMs: number
    readonly requestTimeoutMs: number
    readonly serviceUrls: Record<ServiceSchema["targetService"], string>
  }
>() {}

const ConfigServiceLive = Layer.effect(
  ConfigService,
  Effect.gen(function*() {
    const batchSize = yield* Config.integer("BATCH_SIZE").pipe(
      Config.withDefault(10)
    )
    const maxRetries = yield* Config.integer("MAX_RETRIES").pipe(
      Config.withDefault(3)
    )
    const pollIntervalMs = yield* Config.number("POLL_INTERVAL_MS").pipe(
      Config.withDefault(1000)
    )
    const requestTimeoutMs = yield* Config.integer("REQUEST_TIMEOUT_MS").pipe(
      Config.withDefault(5000)
    )
    const serviceUrls = {
      order: yield* Config.string("ORDER_SERVICE_URL").pipe(
        Config.withDefault("http://localhost:3001")
      ),
      payment: yield* Config.string("PAYMENT_SERVICE_URL").pipe(
        Config.withDefault("http://localhost:3002")
      ),
      inventory: yield* Config.string("INVENTORY_SERVICE_URL").pipe(
        Config.withDefault("http://localhost:3003")
      ),
      shipping: yield* Config.string("SHIPPING_SERVICE_URL").pipe(
        Config.withDefault("http://localhost:3004")
      )
    }

    return {
      batchSize,
      maxRetries,
      pollIntervalMs,
      requestTimeoutMs,
      serviceUrls
    }
  })
)

const buildTargetUrl = (
  service: ServiceSchema["targetService"],
  endpoint: string,
  serviceUrls: Record<ServiceSchema["targetService"], string>
): Effect.Effect<string, Error> => {
  const baseUrl = serviceUrls[service]
  if (!baseUrl) {
    return Effect.fail(new Error(`Unknown service: ${service}`))
  }
  return Effect.succeed(`${baseUrl}/api/v1${endpoint}`)
}

const publishSingleEvent = (event: Outbox) =>
  Effect.gen(function*() {
    const config = yield* ConfigService
    const httpCient = yield* HttpClient.HttpClient
    const repository = yield* OutboxRepository

    yield* Console.info(
      `Publishing event: ${event.eventType} with ID: ${event.eventId}`
    )

    const targetUrl = yield* buildTargetUrl(
      event.targetService,
      event.targetEndpoint,
      config.serviceUrls
    )

    const idempotencyKey = `${event.aggregateId}-${event.eventType}`

    yield* HttpClientRequest.post(
      targetUrl,
      { headers: { "idempotency-key": idempotencyKey } }
    ).pipe(
      HttpClientRequest.bodyText(
        JSON.stringify(event.payload),
        "application/json; charset=UTF-8"
      ),
      httpCient.execute,
      Effect.flatMap((res) => res.json),
      Effect.timeout(Duration.millis(config.requestTimeoutMs))
    )

    const newEvent = Outbox.make({
      ...event,
      isPublished: true,
      publishedAt: new Date()
    })

    yield* repository.save(newEvent)
    yield* Console.info(`Event isPublished successfully: ${event.eventId}`)
  }).pipe(
    Effect.catchAll((error) =>
      Effect.gen(function*() {
        const config = yield* ConfigService
        const repository = yield* OutboxRepository

        yield* Console.error(
          `Failed to publish event ${event.eventId}: ${error.message}`
        )

        const newEvent = Outbox.make({
          ...event,
          publishAttempts: event.publishAttempts + 1,
          lastError: error.message
        })

        if (newEvent.publishAttempts >= config.maxRetries) {
          yield* Console.warn(`Event ${event.eventId} exhausted all retries`)
          const newEvent2 = Outbox.make({
            ...newEvent,
            isPublished: false
          })
          yield* repository.save(newEvent2)
          return
        }

        yield* repository.save(event)
      })
    )
  )

const publishPendingEvents = Effect.gen(function*() {
  const config = yield* ConfigService
  const repository = yield* OutboxRepository

  const events = yield* repository.findUnpublished({
    batchSize: config.batchSize
  })

  if (events.length === 0) {
    yield* Console.info("No pending events found")
    return
  }

  yield* Console.info(`Found ${events.length} unpublished events`)

  // Process events in parallel with limited concurrency
  yield* Effect.forEach(events, publishSingleEvent, {
    concurrency: 5
  })
}).pipe(
  Effect.catchAll((error) =>
    Effect.gen(function*() {
      yield* Console.error(`Error in publishPendingEvents: ${error.message}`)
    })
  )
)

const pollOnce = publishPendingEvents.pipe(
  Effect.tap(() => Console.debug("Poll cycle completed"))
)

const pollingSchedule = (pollIntervalMs: number) =>
  Schedule.fixed(pollIntervalMs).pipe(
    Schedule.intersect(Schedule.forever)
  )

const startPolling = Effect.gen(function*() {
  const config = yield* ConfigService

  yield* Console.info(
    `Starting outbox publisher with interval: ${config.pollIntervalMs}ms`
  )

  const fiber = yield* Effect.fork(
    Effect.repeat(pollOnce, pollingSchedule(config.pollIntervalMs))
  )

  return fiber
})

class OutboxPublisher extends Context.Tag("@context/OutboxPublisher")<
  OutboxPublisher,
  Fiber.RuntimeFiber<[number, number]>
>() {}

const OutboxPublisherLive = Layer.scoped(
  OutboxPublisher,
  Effect.gen(function*() {
    const fiber = yield* startPolling
    return fiber
  })
)

const PgLive = PgClient.layer({
  database: "effect_pg_dev",
  transformQueryNames: String.camelToSnake,
  transformResultNames: String.snakeToCamel
})

export const ApplicationLayer = Layer.mergeAll(
  ConfigServiceLive,
  FetchHttpClient.layer,
  OutboxRepositoryLive,
  PgLive
).pipe(Layer.provideMerge(OutboxPublisherLive))
