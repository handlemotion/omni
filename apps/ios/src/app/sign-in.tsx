import { useMutation } from "@tanstack/react-query";
import { Redirect } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, View } from "react-native";
import { AppleMark } from "@/components/brand/apple-mark.tsx";
import { GoogleMark } from "@/components/brand/google-mark.tsx";
import { OmniGlobe } from "@/components/brand/omni-mark.tsx";
import { IconMail } from "@/components/icons.ts";
import { Button } from "@/components/ui/button.tsx";
import { Screen } from "@/components/ui/screen.tsx";
import { Text } from "@/components/ui/text.tsx";
import { TextField } from "@/components/ui/text-field.tsx";
import {
  sendEmailOtp,
  signInWithSocial,
  useSession,
  useSignInMethods,
  verifyEmailOtp,
} from "@/lib/session.ts";
import { useSplashDone } from "@/lib/splash.ts";
import { colors, gutter, space } from "@/theme/tokens.ts";

type Step = "choose" | "email" | "code";

/** Native sign-in: direct Google/Apple OAuth or 6-digit email OTP, with no web login detour. */
export default function SignIn() {
  const session = useSession();
  const methods = useSignInMethods();
  const [step, setStep] = useState<Step>("choose");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [activeSocial, setActiveSocial] = useState<"google" | "apple" | null>(null);

  const social = useMutation({
    mutationFn: (provider: "google" | "apple") => {
      setActiveSocial(provider);
      return signInWithSocial(provider);
    },
    onError: () => setActiveSocial(null),
  });
  const sendOtp = useMutation({
    mutationFn: (address: string) => sendEmailOtp(address),
    onSuccess: () => {
      setOtp("");
      setStep("code");
    },
  });
  const verifyOtp = useMutation({
    mutationFn: ({ address, code }: { address: string; code: string }) =>
      verifyEmailOtp(address, code),
  });

  useSplashDone(!session.data);
  if (session.data) return <Redirect href="/mail" />;

  const finishingSocial = activeSocial !== null && (social.isPending || session.isPending);
  const finishingOtp = verifyOtp.isPending || (verifyOtp.isSuccess && session.isPending);
  const busy = finishingSocial || sendOtp.isPending || finishingOtp;
  const errorText = {
    choose: social.error?.message,
    email: sendOtp.error?.message,
    code: verifyOtp.error?.message,
  }[step];

  const submitEmail = () => {
    const trimmed = email.trim();
    if (trimmed && !busy) sendOtp.mutate(trimmed);
  };
  const submitCode = (value = otp) => {
    const trimmed = value.trim();
    if (trimmed.length === 6 && !busy) verifyOtp.mutate({ address: email.trim(), code: trimmed });
  };

  return (
    <Screen style={styles.screen}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.body}
      >
        <View style={styles.hero}>
          <OmniGlobe size={40} />
          <Text size="title" weight="medium" accessibilityRole="header" style={styles.center}>
            {step === "code" ? "Enter code" : "Sign in to Omni"}
          </Text>
          {step === "code" ? (
            <Text size="subhead" tone="mutedForeground" style={styles.center}>
              {email.trim()}
            </Text>
          ) : null}
        </View>
        <View style={styles.footer}>
          {errorText ? (
            <Text size="sm" tone="danger" style={styles.center}>
              {errorText}
            </Text>
          ) : null}
          {step === "choose" ? (
            <ChooseStep
              busy={busy}
              activeSocial={finishingSocial ? activeSocial : null}
              methods={methods.data}
              onSocial={(provider) => social.mutate(provider)}
              onEmail={() => setStep("email")}
            />
          ) : step === "email" ? (
            <EmailStep
              email={email}
              busy={busy}
              pending={sendOtp.isPending}
              onChange={setEmail}
              onSubmit={submitEmail}
              onBack={() => setStep("choose")}
            />
          ) : (
            <CodeStep
              otp={otp}
              busy={busy}
              pending={finishingOtp}
              onChange={(digits) => {
                setOtp(digits);
                if (digits.length === 6) submitCode(digits);
              }}
              onSubmit={() => submitCode()}
              onResend={() => sendOtp.mutate(email.trim())}
              onBack={() => {
                setOtp("");
                setStep("email");
              }}
            />
          )}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function ChooseStep(props: {
  busy: boolean;
  activeSocial: "google" | "apple" | null;
  methods?: { google: boolean; apple: boolean };
  onSocial: (provider: "google" | "apple") => void;
  onEmail: () => void;
}) {
  return (
    <>
      <View style={styles.actions}>
        <Button
          intent="outline"
          size="lg"
          icon={GoogleMark}
          label="Continue with Google"
          isPending={props.activeSocial === "google"}
          disabled={props.busy || props.methods?.google === false}
          onPress={() => props.onSocial("google")}
        />
        <Button
          intent="outline"
          size="lg"
          icon={AppleMark}
          label="Sign in with Apple"
          isPending={props.activeSocial === "apple"}
          disabled={props.busy || props.methods?.apple === false}
          onPress={() => props.onSocial("apple")}
        />
        <Button
          intent="outline"
          size="lg"
          icon={IconMail}
          label="Continue with email"
          disabled={props.busy}
          onPress={props.onEmail}
        />
      </View>
      <Text size="xs" tone="subtleForeground" style={[styles.center, styles.legal]}>
        By continuing, you agree to our Terms of Service and Privacy Policy.
      </Text>
    </>
  );
}

function EmailStep(props: {
  email: string;
  busy: boolean;
  pending: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onBack: () => void;
}) {
  return (
    <View style={styles.actions}>
      <TextField
        label="Email"
        placeholder="you@example.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="emailAddress"
        returnKeyType="go"
        autoFocus
        value={props.email}
        onChangeText={props.onChange}
        onSubmitEditing={props.onSubmit}
      />
      <Button
        size="lg"
        label="Continue"
        isPending={props.pending}
        disabled={!props.email.trim() || props.busy}
        onPress={props.onSubmit}
      />
      <Button
        intent="quiet"
        size="sm"
        label="Back"
        disabled={props.busy}
        onPress={props.onBack}
        style={styles.centeredButton}
      />
    </View>
  );
}

function CodeStep(props: {
  otp: string;
  busy: boolean;
  pending: boolean;
  onChange: (digits: string) => void;
  onSubmit: () => void;
  onResend: () => void;
  onBack: () => void;
}) {
  return (
    <View style={styles.actions}>
      <TextField
        label="6-digit code"
        placeholder="000000"
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={6}
        autoFocus
        value={props.otp}
        onChangeText={(next) => props.onChange(next.replace(/\D/g, "").slice(0, 6))}
        onSubmitEditing={props.onSubmit}
        style={styles.otpInput}
      />
      <Button
        size="lg"
        label="Sign in"
        isPending={props.pending}
        disabled={props.otp.length < 6 || props.busy}
        onPress={props.onSubmit}
      />
      <View style={styles.codeLinks}>
        <Button
          intent="quiet"
          size="sm"
          label="Resend"
          disabled={props.busy}
          onPress={props.onResend}
        />
        <Button
          intent="quiet"
          size="sm"
          label="Back"
          disabled={props.busy}
          onPress={props.onBack}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.sidebar },
  body: { flex: 1, paddingHorizontal: gutter + space(1), paddingBottom: space(4) },
  hero: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space(5.5),
    paddingBottom: space(6),
  },
  center: { textAlign: "center" },
  footer: { gap: space(4.5) },
  actions: { gap: space(2.5) },
  legal: { paddingHorizontal: space(4) },
  centeredButton: { alignSelf: "center" },
  otpInput: { textAlign: "center", letterSpacing: 6 },
  codeLinks: { flexDirection: "row", justifyContent: "center", gap: space(6) },
});
