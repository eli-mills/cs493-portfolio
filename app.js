const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT;
const HOST = process.env.NODE_ENV === "production" ? "0.0.0.0" : "localhost";
const { authentication, boats, users } = require("./src/controller");

app.enable("trust proxy");

/****************************************************************
 *                                                              *
 *                      EXPRESS ROUTES                          *
 *                                                              *
****************************************************************/

app.use(express.json());
app.use("/", authentication);
app.use("/boats", boats);
app.use("/users", users);
app.use(express.static(path.join(__dirname, "public")));

/****************************************************************
 *                                                              *
 *                      INITIALIZE SERVER                       *
 *                                                              *
 ****************************************************************/
app.listen(PORT, HOST, () => {
  console.log(`Listening on port ${PORT}`);
  console.log(`NODE_ENV: ${process.env.NODE_ENV}`);
});