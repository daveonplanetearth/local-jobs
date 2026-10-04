// Local development server. In Azure Static Web Apps, public/ is served statically and /api/jobs runs as an Azure Function (api/).
import express from "express";
import { getAllJobs } from "./api/src/jobs.js";

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static("public"));

app.get("/api/jobs", async (_req,res)=>{
  const { status, body }=await getAllJobs();
  res.status(status).json(body);
});
app.listen(PORT,()=>console.log(`Local Jobs Viewer: http://localhost:${PORT}`));
