import mongoose from 'mongoose';

let moviesConnection; // Global variable to hold the movies DB connection

const connectDBs = async () => {
  try {
    // ✅ Connect to AUTHENTICATION DB using the default mongoose instance
    await mongoose.connect(`${process.env.MONGODB_URI}/AUTHENTICATION`, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ Connected to AUTHENTICATION DB');

    // ✅ Create a separate connection for moviesDB
    moviesConnection = mongoose.createConnection(process.env.MONGO_URI);

    // ✅ Connection success & error handlers
    moviesConnection.on('connected', () => {
      console.log('✅ Connected to moviesDB');
    });

    moviesConnection.on('error', (err) => {
      console.error('❌ moviesDB connection error:', err.message);
    });
  } catch (error) {
    console.error('❌ MongoDB connection setup failed:', error.message);
    process.exit(1);
  }
};

export { connectDBs, moviesConnection };
