import * as crypto from "crypto";
// import * as fs from "fs";
import type * as mqtt from "mqtt";

export interface SourceMqttConfig {
  url: string;
  topicFilter: string;
  clientOptions: mqtt.IClientOptions;
  subscribeOptions: mqtt.IClientSubscribeOptions;
}

export interface DestMqttConfig {
  url: string;
  clientOptions: mqtt.IClientOptions;
  qosMax: mqtt.QoS;
  forwardRetain: boolean;
}

export interface HealthCheckConfig {
  port: number;
}

export interface Config {
  source: SourceMqttConfig;
  dest: DestMqttConfig;
  healthCheck: HealthCheckConfig;
  saveToFile: SaveToFileConfig;
}

const getRequired = (envVariable: string) => {
  const variable = process.env[envVariable];
  if (variable === undefined) {
    throw new Error(`${envVariable} must be defined`);
  }
  return variable;
};

const getOptional = (envVariable: string) => process.env[envVariable];

const getOptionalNonNegativeInteger = (
  envVariable: string,
): number | undefined => {
  let result;
  const str = getOptional(envVariable);
  if (str !== undefined) {
    const num = parseInt(str, 10);
    if (Number.isNaN(num) || num < 0) {
      throw new Error(
        `If defined, ${envVariable} must be a non-negative integer.`,
      );
    }
    result = num;
  }
  return result;
};

const getOptionalBooleanWithDefault = (
  envVariable: string,
  defaultValue: boolean,
) => {
  let result = defaultValue;
  const str = getOptional(envVariable);
  if (str !== undefined) {
    if (!["false", "true"].includes(str)) {
      throw new Error(`${envVariable} must be either "false" or "true"`);
    }
    result = str === "true";
  }
  return result;
};

const getQoS = (envVar: string, defaultStr: string): mqtt.QoS => {
  const qos = parseInt(process.env[envVar] ?? defaultStr, 10);
  if (qos !== 0 && qos !== 1 && qos !== 2) {
    throw new Error(
      `If defined, ${envVar} must be 0, 1 or 2. Default is ${defaultStr}.`,
    );
  }
  return qos;
};

export interface SaveToFileConfig {
  enabled: boolean;
  filePath: string;
}

const getSaveToFileConfig = (): SaveToFileConfig => {
  const enabled = getOptionalBooleanWithDefault("SAVE_MESSAGES_TO_FILE", false);
  const filePath =
    getOptional("SAVE_MESSAGES_FILE_PATH") ?? "./messages.ndjson";
  return { enabled, filePath };
};

const getMqttAuthFromPaths = (usernameEnv: string, passwordEnv: string) => {
  let result;
  const usernamePath = process.env[usernameEnv];
  const passwordPath = process.env[passwordEnv];
  const isUsernamePath = usernamePath !== undefined;
  const isPasswordPath = passwordPath !== undefined;
  if (isUsernamePath !== isPasswordPath) {
    throw new Error(
      `Either both or neither of ${usernameEnv} and ${passwordEnv} must be defined`,
    );
  }
  if (isUsernamePath && isPasswordPath) {
    result = {
      username: usernamePath,
      password: passwordPath,
    };
  }
  return result;
};

const createMqttClientId = (prefixEnv: string, suffixLengthEnv: string) => {
  const prefix = getRequired(prefixEnv);
  const suffixLength = getOptionalNonNegativeInteger(suffixLengthEnv) ?? 0;
  const suffix = crypto
    .randomBytes(suffixLength)
    .toString("base64")
    .slice(0, suffixLength);
  const clientId = prefix + suffix;
  return clientId;
};

const getSourceMqttConfig = (): SourceMqttConfig => {
  const url = getRequired("SOURCE_MQTT_URL");
  const auth = getMqttAuthFromPaths(
    "SOURCE_MQTT_USERNAME_PATH",
    "SOURCE_MQTT_PASSWORD_PATH",
  );
  const clientId = createMqttClientId(
    "SOURCE_MQTT_CLIENT_ID_PREFIX",
    "SOURCE_MQTT_CLIENT_ID_SUFFIX_LENGTH",
  );
  const topicFilter = getRequired("SOURCE_MQTT_TOPIC_FILTER");
  const qos = getQoS("SOURCE_MQTT_QOS", "2");
  const clean = getOptionalBooleanWithDefault(
    "SOURCE_MQTT_CLEAN_SESSION",
    false,
  );
  return {
    url,
    topicFilter,
    clientOptions: {
      clientId,
      clean,
      ...auth,
    },
    subscribeOptions: {
      qos,
    },
  };
};

const getDestMqttConfig = (): DestMqttConfig => {
  const url = getRequired("DEST_MQTT_URL");
  const auth = getMqttAuthFromPaths(
    "DEST_MQTT_USERNAME_PATH",
    "DEST_MQTT_PASSWORD_PATH",
  );
  const clientId = createMqttClientId(
    "DEST_MQTT_CLIENT_ID_PREFIX",
    "DEST_MQTT_CLIENT_ID_SUFFIX_LENGTH",
  );
  const clean = getOptionalBooleanWithDefault("DEST_MQTT_CLEAN_SESSION", true);
  const qosMax = getQoS("FORWARD_QOS_MAX", "1");
  const forwardRetain = getOptionalBooleanWithDefault("FORWARD_RETAIN", true);
  return {
    url,
    clientOptions: {
      clientId,
      clean,
      ...auth,
    },
    qosMax,
    forwardRetain,
  };
};

const getHealthCheckConfig = () => {
  const port = parseInt(getOptional("HEALTH_CHECK_PORT") ?? "8080", 10);
  return { port };
};

export const getConfig = (): Config => ({
  source: getSourceMqttConfig(),
  dest: getDestMqttConfig(),
  healthCheck: getHealthCheckConfig(),
  saveToFile: getSaveToFileConfig(),
});
