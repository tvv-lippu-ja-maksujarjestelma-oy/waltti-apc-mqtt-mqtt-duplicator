import type mqtt from "async-mqtt";
import type pino from "pino";
import { getConfig } from "./config";
import { createLogger } from "./gcpLogging";
import createHealthCheckServer from "./healthCheck";
import createDuplicator from "./mqtt";
import transformUnknownToError from "./util";

/**
 * Exit gracefully.
 */
const exitGracefully = async (
  logger: pino.Logger,
  exitCode: number,
  exitError?: Error,
  setHealthOk?: (isOk: boolean) => void,
  closeHealthCheckServer?: () => Promise<void>,
  sourceClient?: mqtt.AsyncMqttClient,
  destClient?: mqtt.AsyncMqttClient,
  mqttUnsubscribe?: () => Promise<void>,
) => {
  if (exitError) {
    logger.fatal(exitError);
  }
  logger.info("Start exiting gracefully");
  process.exitCode = exitCode;
  try {
    if (setHealthOk) {
      logger.info("Set health checks to fail");
      setHealthOk(false);
    }
  } catch (err) {
    logger.error(
      { err },
      "Something went wrong when setting health checks to fail",
    );
  }
  try {
    if (mqttUnsubscribe) {
      logger.info("Unsubscribe from source MQTT topics");
      await mqttUnsubscribe();
    }
  } catch (err) {
    logger.error(
      { err },
      "Something went wrong when unsubscribing from MQTT topics",
    );
  }
  try {
    if (sourceClient) {
      logger.info("Disconnect source MQTT client");
      await sourceClient.end();
    }
  } catch (err) {
    logger.error(
      { err },
      "Something went wrong when disconnecting source MQTT client",
    );
  }
  try {
    if (destClient) {
      logger.info("Disconnect destination MQTT client");
      await destClient.end();
    }
  } catch (err) {
    logger.error(
      { err },
      "Something went wrong when disconnecting destination MQTT client",
    );
  }
  try {
    if (closeHealthCheckServer) {
      logger.info("Close health check server");
      await closeHealthCheckServer();
    }
  } catch (err) {
    logger.error(
      { err },
      "Something went wrong when closing health check server",
    );
  }
  logger.info("Exit process");
  process.exit(); // eslint-disable-line no-process-exit
};

/**
 * Main function.
 */
/* eslint-disable @typescript-eslint/no-floating-promises */
(async () => {
  /* eslint-enable @typescript-eslint/no-floating-promises */
  const serviceName = "mqtt-mqtt-duplicator";
  try {
    const logger = createLogger({ name: serviceName });

    let setHealthOk: (isOk: boolean) => void;
    let closeHealthCheckServer: () => Promise<void>;
    let sourceClient: mqtt.AsyncMqttClient;
    let destClient: mqtt.AsyncMqttClient;
    let mqttUnsubscribe: () => Promise<void>;

    const exitHandler = (exitCode: number, exitError?: Error) => {
      // Exit next.
      /* eslint-disable @typescript-eslint/no-floating-promises */
      exitGracefully(
        logger,
        exitCode,
        exitError,
        setHealthOk,
        closeHealthCheckServer,
        sourceClient,
        destClient,
        mqttUnsubscribe,
      );
      /* eslint-enable @typescript-eslint/no-floating-promises */
    };

    try {
      // Handle different kinds of exits.
      process.on("beforeExit", () => exitHandler(1, new Error("beforeExit")));
      process.on("unhandledRejection", (reason) =>
        exitHandler(1, transformUnknownToError(reason)),
      );
      process.on("uncaughtException", (err) => exitHandler(1, err));
      process.on("SIGINT", (signal) => exitHandler(130, new Error(signal)));
      process.on("SIGQUIT", (signal) => exitHandler(131, new Error(signal)));
      process.on("SIGTERM", (signal) => exitHandler(143, new Error(signal)));

      logger.info(`Start service ${serviceName}`);
      logger.info("Read configuration");
      const config = getConfig();
      logger.info("Create health check server");
      ({ closeHealthCheckServer, setHealthOk } = createHealthCheckServer(
        config.healthCheck,
      ));
      logger.info("Start MQTT duplicator");
      ({
        sourceClient,
        destClient,
        unsubscribe: mqttUnsubscribe,
      } = await createDuplicator(
        logger,
        config.source,
        config.dest,
        config.saveToFile,
      ));
      logger.info("Set health check status to OK");
      setHealthOk(true);
    } catch (err) {
      exitHandler(1, transformUnknownToError(err));
    }
  } catch (loggerErr) {
    // eslint-disable-next-line no-console
    console.error("Failed to start logging:", loggerErr);
    process.exit(1); // eslint-disable-line no-process-exit
  }
})();
