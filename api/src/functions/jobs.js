import { app } from "@azure/functions";
import { getAllJobs } from "../jobs.js";

app.http("jobs", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "jobs",
  handler: async () => {
    const { status, body } = await getAllJobs();
    return { status, jsonBody: body, headers: { "Cache-Control": "no-store" } };
  },
});
