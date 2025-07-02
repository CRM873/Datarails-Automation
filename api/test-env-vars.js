// api/test-env-vars.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const sshKey = process.env.TOAST_SSH_PRIVATE_KEY;
    const gmailPassword = process.env.GMAIL_APP_PASSWORD;
  
    res.status(200).json({
      success: true,
      message: "Environment variables check",
      variables: {
        TOAST_SSH_PRIVATE_KEY: sshKey ? `Found (${sshKey.length} characters)` : 'NOT FOUND',
        GMAIL_APP_PASSWORD: gmailPassword ? `Found (${gmailPassword.length} characters)` : 'NOT FOUND'
      },
      allEnvVars: Object.keys(process.env).filter(key => 
        key.includes('TOAST') || key.includes('GMAIL') || key.includes('RESEND')
      )
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
