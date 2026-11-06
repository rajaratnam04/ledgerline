/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow node:sqlite and native crypto in server routes
  serverExternalPackages: ['node:sqlite'],
};

export default nextConfig;