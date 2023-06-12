const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const app = express();
const jwt = require("jsonwebtoken");
require("dotenv").config();
const stripe = require("stripe")(process.env.PAYMENT_SECRET_KEY);
const port = process.env.PORT || 5000;

// middle ware
app.use(cors());
app.use(express.json());

const verifiedJWT = (req, res, next) => {
  const authorization = req.headers.authorization;

  if (!authorization) {
    return res.status(401).send({ error: true, message: "unauthorized user" });
  }
  //------Bearer token------
  const token = authorization.split(" ")[1];

  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decode) => {
    if (err) {
      return res
        .status(401)
        .send({ error: true, message: "unauthorized error" });
    } else {
      req.decode = decode;
      next();
    }
  });
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.sk94onm.mongodb.net/?retryWrites=true&w=majority`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const usersCollection = client.db("languageDb").collection("users");
    const classesCollection = client.db("languageDb").collection("courses");
    const cartCollection = client.db("languageDb").collection("carts");
    const paymentCollection = client.db("languageDb").collection("payments");

    app.post("/users", async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const alreadyExistsUser = await usersCollection.findOne(query);
      if (alreadyExistsUser) {
        return res.send({
          message: "You are login or signup already with your email",
        });
      }
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    //----jwt token----
    app.post("/jwt", (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "1h",
      });
      res.send({ token });
    });

    //------Verify that user is Admin or Not-----
    const verifyAdmin = async (req, res, next) => {
      const email = req.decode.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      if (user?.role !== "admin") {
        return res
          .status(401)
          .send({ error: true, message: "You are not an admin" });
      }

      next();
    };

    //----------verify user is Instructors or not---------

    const verifyInstructors = async (req, res, next) => {
      const email = req.decode.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      if (user?.role !== "instructors") {
        return res
          .status(401)
          .send({ error: true, message: "You are not a instructors" });
      }
      next();
    };

    // Instructors Added Classes using post
    app.post("/courses", verifiedJWT, verifyInstructors, async (req, res) => {
      const course = req.body;
      const result = await classesCollection.insertOne(course);
      res.send(result);
    });

    app.patch("/courses/:id", async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;
      if (status == "approve") {
        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            status: status,
          },
        };
        const result = await classesCollection.updateOne(filter, updateDoc);
        res.send(result);
      }
      if (status === "deny") {
        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            status: status,
          },
        };
        const result = await classesCollection.updateOne(filter, updateDoc);
        res.send(result);
      }
    });

    // After clicked enrolled button  added to My selected class for student dashboard
    app.post("/carts", async (req, res) => {
      const cartItem = req.body;
      const cartId = cartItem.courseId;
      const query = { courseId: cartId };
      const alreadyExistsId = await cartCollection.findOne(query);
      if (alreadyExistsId) {
        return res.send({ message: "You have already clicked Select Button" });
      }
      const result = await cartCollection.insertOne(cartItem);
      res.send(result);
    });

    // app.get("/carts", verifiedJWT, async (req, res) => {
    //   const carts = await cartCollection.find().toArray();
    //   res.send(carts);
    // });

    // delete specific cart from cartCollection
    app.delete("/carts/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await cartCollection.deleteOne(query);
      res.send(result);
    });

    app.get("/carts/:id", verifiedJWT, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await cartCollection.find(query).toArray();
      res.send(result);
    });

    app.get("/carts", verifiedJWT, async (req, res) => {
      const email = req.query.email;

      if (!email) {
        return res.send([]);
      }

      const decodedEmail = req.decode.email;

      if (email !== decodedEmail) {
        return res
          .status(403)
          .send({ error: true, message: "Forbidden access" });
      }
      const query = { email: req.query.email };
      const result = await cartCollection.find(query).toArray();
      res.send(result);
    });

    //--------------Create payment intent-----

    app.post("/create-payment-intent", verifiedJWT, async (req, res) => {
      const { price } = req.body;
      const amount = price * 100;

      // Create a PaymentIntent with the order amount and currency
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: "usd",
        payment_method_types: ["card"],
      });

      res.send({
        clientSecret: paymentIntent.client_secret,
      });
    });

    //-------------payment related api------------
    app.post("/payments", async (req, res) => {
      const payment = req.body;
      const courseId = payment.courseId;
      const insertResult = await paymentCollection.insertOne(payment);
      const query = { _id: new ObjectId(payment.cartId) };
      const deleteResult = await cartCollection.deleteOne(query);
      
      const filter = { _id: new ObjectId(courseId) };
      const classDoc = await classesCollection.findOne(filter);
      const currentSeats = classDoc.seats;
      const currentEnrolled = classDoc.enrolled;

      // Update the seats and enrolled values
      const updateDoc = {
        $set: {
          seats: currentSeats - 1,
          enrolled: currentEnrolled + 1,
        },
      };

      const updateEnroll = await classesCollection.updateOne(filter, updateDoc);

      res.send({ insertResult, deleteResult, updateEnroll });
    });

    app.get("/payments/enrolled/:email", verifiedJWT, async (req, res) => {
      const email = req.params.email;
      const query = { email: email };
      const payments = await paymentCollection.find(query).toArray();
      res.send(payments);
    });

    app.get("/payments/:email", verifiedJWT, async (req, res) => {
      const email = req.params.email;
      const query = { email: email };
      const result = await paymentCollection
        .find(query)
        .sort({ date: -1 })
        .toArray();
      res.send(result);
    });

    app.patch(
      "/courses/feedback/:id",
      verifiedJWT,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const { feedback } = req.body;
        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            feedback: feedback,
          },
        };
        const result = await classesCollection.updateOne(filter, updateDoc);
        res.send(result);
      }
    );

    app.get("/courses", verifiedJWT, verifyAdmin, async (req, res) => {
      const result = await classesCollection.find().toArray();
      res.send(result);
    });

    app.get(
      "/courses/allCourses",
      verifiedJWT,
      verifyInstructors,
      async (req, res) => {
        const result = await classesCollection.find().toArray();
        res.send(result);
      }
    );

    app.get("/users/verify/:email", verifiedJWT, async (req, res) => {
      const email = req.params.email;
      if (req.decode.email !== email) {
        res.send({ user: false });
      }
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      if (!user?.role) {
        const result = { role: "student" };
        return res.send(result);
      }
      const result = { role: user?.role };
      res.send(result);
    });

    // Find All Approve classes
    app.get("/courses/approve", async (req, res) => {
      const query = { status: "approve" };
      const result = await classesCollection.find(query).toArray();
      res.send(result);
    });

    // Find all instructors
    app.get("/users/instructors", async (req, res) => {
      const query = { role: "instructors" };
      const result = await usersCollection.find(query).toArray();
      res.send(result);
    });

    //----Check user is admin or not---

    app.get(
      "/users/admin/:email",
      verifiedJWT,
      verifyAdmin,
      async (req, res) => {
        const email = req.params.email;
        if (req.decode.email !== email) {
          res.send({ admin: false });
        }
        const query = { email: email };
        const user = await usersCollection.findOne(query);
        const result = { admin: user?.role === "admin" };
        res.send(result);
      }
    );

    //check user is instructors or not

    app.get(
      "/users/instructors/:email",
      verifiedJWT,
      verifyInstructors,
      async (req, res) => {
        const email = req.params.email;
        if (req.decode.email !== email) {
          res.send({ instructors: false });
        }
        const query = { email: email };
        const user = await usersCollection.findOne(query);
        const result = { instructors: user?.role === "instructors" };
        res.send(result);
      }
    );

    app.get("/users", verifiedJWT, verifyAdmin, async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    app.patch("/users/:id", async (req, res) => {
      const id = req.params.id;
      const body = req.body;
      if (body.adminId == 1) {
        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            role: "admin",
          },
        };
        const result = await usersCollection.updateOne(filter, updateDoc);
        res.send(result);
      }

      if (body.instructorsId == 2) {
        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            role: "instructors",
          },
        };
        const result = await usersCollection.updateOne(filter, updateDoc);
        res.send(result);
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Server is running");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
