import mqtt from "async-mqtt";
import * as fs from "fs";
import * as path from "path";
import type pino from "pino";
import type {
  DestMqttConfig,
  SourceMqttConfig,
  SaveToFileConfig,
} from "./config";
import transformUnknownToError from "./util";

export interface DuplicatorClients {
  sourceClient: mqtt.AsyncMqttClient;
  destClient: mqtt.AsyncMqttClient;
  unsubscribe: () => Promise<void>;
}

const connectMqtt = async (
  logger: pino.Logger,
  name: string,
  url: string,
  options: mqtt.IClientOptions,
) => {
  logger.info({ name, url }, "Connect to MQTT broker");
  // There is a try-catch at the caller.
  // eslint-disable-next-line @typescript-eslint/return-await
  return await mqtt.connectAsync(url, options);
};

const createDuplicator = async (
  logger: pino.Logger,
  source: SourceMqttConfig,
  dest: DestMqttConfig,
  saveToFile?: SaveToFileConfig,
): Promise<DuplicatorClients> => {
  const sourceClient = await connectMqtt(
    logger,
    "source",
    source.url,
    source.clientOptions,
  );
  const destClient = await connectMqtt(
    logger,
    "dest",
    dest.url,
    dest.clientOptions,
  );

  // Connection lifecycle debug logs
  const attachClientEventLogs = (
    name: string,
    client: mqtt.AsyncMqttClient,
    clientId?: string | undefined,
  ) => {
    client.on("connect", () =>
      logger.debug({ name, clientId }, "MQTT client connected"),
    );
    client.on("reconnect", () =>
      logger.warn({ name, clientId }, "MQTT client reconnecting"),
    );
    client.on("close", () =>
      logger.warn({ name, clientId }, "MQTT client connection closed"),
    );
    client.on("offline", () =>
      logger.warn({ name, clientId }, "MQTT client offline"),
    );
    client.on("error", (err) =>
      logger.error({ name, clientId, err }, "MQTT client error"),
    );
  };
  attachClientEventLogs("source", sourceClient, source.clientOptions.clientId);
  attachClientEventLogs("dest", destClient, dest.clientOptions.clientId);

  const logIntervalInSeconds = 60;
  let nRecentForwarded = 0;
  let nRecentDropped = 0;

  // Optional NDJSON file writer
  let writer: fs.WriteStream | undefined;
  let writerClosed = false;
  const ensureWriter = () => {
    if (!saveToFile?.enabled || writer || writerClosed) return;
    try {
      const dir = path.dirname(saveToFile.filePath);
      if (dir && dir !== ".") {
        fs.mkdirSync(dir, { recursive: true });
      }
      writer = fs.createWriteStream(saveToFile.filePath, { flags: "a" });
      writer.on("error", (err) => {
        logger.error({ err }, "File writer error");
      });
      writer.on("close", () => {
        writerClosed = true;
      });
      logger.info({ filePath: saveToFile.filePath }, "Enabled save-to-file");
    } catch (err) {
      logger.error({ err }, "Failed to initialize save-to-file writer");
    }
  };
  ensureWriter();

  setInterval(() => {
    logger.info(
      { nRecentForwarded, nRecentDropped },
      "messages forwarded to destination MQTT",
    );
    nRecentForwarded = 0;
    nRecentDropped = 0;
  }, 1_000 * logIntervalInSeconds);

  sourceClient.on("message", (topic, message, packet) => {
    const qos = Math.min(packet.qos, dest.qosMax) as mqtt.QoS;
    const retain = dest.forwardRetain ? packet.retain : false;
    logger.debug(
      {
        topic,
        incomingQos: packet.qos,
        incomingRetain: packet.retain,
        dup: packet.dup,
        payloadBytes: message.length,
      },
      "Received message from source MQTT",
    );

    // Save to file (NDJSON) if enabled
    if (saveToFile?.enabled && writer && !writerClosed) {
      try {
        let payloadEncoding: "utf8" | "base64" = "utf8";
        let payload: string;
        try {
          payload = message.toString("utf8");
          // Validate round-trip to check it's valid UTF-8
          if (!Buffer.from(payload, "utf8").equals(message)) {
            payloadEncoding = "base64";
            payload = message.toString("base64");
          }
        } catch {
          payloadEncoding = "base64";
          payload = message.toString("base64");
        }
        const record = {
          time: new Date().toISOString(),
          topic,
          incomingQos: packet.qos,
          incomingRetain: packet.retain,
          dup: packet.dup,
          payloadEncoding,
          payload,
        };
        writer.write(`${JSON.stringify(record)}\n`);
      } catch (err) {
        logger.error({ err }, "Failed to write message to file");
      }
    }
    destClient.publish(topic, message, { qos, retain }).then(
      () => {
        nRecentForwarded += 1;
        logger.debug(
          { topic, qos, retain, payloadBytes: message.length },
          "Published message to destination MQTT",
        );
      },
      (error) => {
        const err = transformUnknownToError(error);
        logger.error(
          { err, topic, qos, retain },
          "Publishing to destination failed",
        );
        nRecentDropped += 1;
      },
    );
  });

  logger.info("Subscribe to source MQTT topics");
  try {
    await sourceClient.subscribe(source.topicFilter, source.subscribeOptions);
    logger.debug(
      {
        topicFilter: source.topicFilter,
        qos: source.subscribeOptions.qos,
        clientId: source.clientOptions.clientId,
      },
      "Subscribed to source MQTT topics",
    );
  } catch (err) {
    logger.fatal({ err }, "Subscribing to source MQTT topics failed");
    throw err;
  }

  const unsubscribe = async () => {
    try {
      return await sourceClient.unsubscribe(source.topicFilter);
    } catch (err) {
      throw transformUnknownToError(err);
    }
  };

  // Close writer when clients close
  const closeWriterIfOpen = () => {
    if (writer && !writerClosed) {
      try {
        writer.end();
      } catch (err) {
        logger.error({ err }, "Failed to close file writer");
      }
    }
  };
  sourceClient.on("close", closeWriterIfOpen);
  destClient.on("close", closeWriterIfOpen);

  return { sourceClient, destClient, unsubscribe };
};

export default createDuplicator;
