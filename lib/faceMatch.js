// Automatic face matching for face checks: compares the new straight-on photo
// with the driver's reference (their first passed face check, else the licence
// photo). AWS Rekognition CompareFaces, about $0.001 per comparison, when
// AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION are set. Otherwise
// isReady() is false and every face check goes to an admin.

let client = null;
const isReady = () => Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_REGION);

/** Returns { similarity (0-100), faces } for the best match of the probe's face in the reference. */
const compareFaces = async (referenceBytes, probeBytes) => {
  const { RekognitionClient, CompareFacesCommand } = require('@aws-sdk/client-rekognition');
  client ??= new RekognitionClient({ region: process.env.AWS_REGION });
  const result = await client.send(new CompareFacesCommand({
    SourceImage: { Bytes: probeBytes },
    TargetImage: { Bytes: referenceBytes },
    SimilarityThreshold: 50
  }));
  const best = Math.max(0, ...(result.FaceMatches || []).map((match) => match.Similarity || 0));
  return { similarity: Math.round(best * 10) / 10, faces: (result.FaceMatches || []).length + (result.UnmatchedFaces || []).length };
};

module.exports = { isReady, compareFaces };
