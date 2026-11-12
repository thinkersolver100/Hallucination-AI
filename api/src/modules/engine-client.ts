import axios from "axios";
import { env } from "../config/env.js";

export const engineClient = axios.create({
  baseURL: env.ENGINE_URL,
  timeout: 60_000,
  headers: {
    "X-Service-Key": env.HALUDEC_SERVICE_KEY,
    "Content-Type": "application/json",
  },
});
