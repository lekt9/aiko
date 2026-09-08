import {describe,it,expect} from "vitest";
import {nativeLoginPageError,nativeOtpSubmission,type NativeLoginPanelView} from "../src/lib/native-login-input";
const attemptId="11111111-1111-4111-8111-111111111111",challengeId="22222222-2222-4222-8222-222222222222",submissionId="33333333-3333-4333-8333-333333333333";
const view=():NativeLoginPanelView=>({status:"pending",domain:"example.com",fields:["code"],attemptId,challenge:{id:challengeId,revision:2,expiresAt:5000}});
describe("private OTP binding",()=>{
  it("binds a fresh code to the challenge the user actually saw",()=>{
    expect(nativeOtpSubmission(view(),view(),1000,submissionId)).toEqual({attemptId,challengeId,expectedRevision:2,submissionId});
  });
  it("rejects changed attempts, challenges, revisions, expiry, origin and form",()=>{
    for(const current of [{...view(),domain:"another.example"},{...view(),attemptId:submissionId},{...view(),challenge:{...view().challenge!,id:submissionId}},{...view(),challenge:{...view().challenge!,revision:3}},{...view(),challenge:{...view().challenge!,expiresAt:6000}},{...view(),fields:["password"]},{...view(),requiresOrigin:"https://elsewhere.example"},{...view(),status:"connected"}])
      expect(()=>nativeOtpSubmission(view(),current,1000,submissionId)).toThrow("changed or expired");
    expect(()=>nativeOtpSubmission(view(),view(),5000,submissionId)).toThrow("expired");
    expect(()=>nativeOtpSubmission(undefined,view(),1000,submissionId)).toThrow();
  });
  it("an acknowledged or uncertain submission cannot acquire a new submission ID for the same challenge",()=>{
    for(const status of ["dispatched","acknowledged"] as const){
      const current={...view(),submission:{id:submissionId,challengeId,revision:2,status}};
      expect(()=>nativeOtpSubmission(view(),current,1000,crypto.randomUUID())).toThrow("already submitted");
    }
  });
});

describe("private page failures",()=>{
 it("rejects opaque and non-HTTPS providers from older runners",()=>{
  for(const requiresOrigin of ["null","chrome-error://chromewebdata","http://identity.example.com","https://user:pass@identity.example.com","https://identity.example.com/path"])
   expect(nativeLoginPageError({...view(),requiresOrigin,currentHost:"identity.example.com"})).toContain("could not be loaded");
  expect(nativeLoginPageError({...view(),requiresOrigin:"https://identity.example.com",currentHost:"identity.example.com"})).toBeUndefined();
 });
 it("distinguishes a failed load from uncertain submission",()=>{
  expect(nativeLoginPageError({...view(),pageError:"navigation_failed"})).toContain("could not be loaded");
  expect(nativeLoginPageError({...view(),pageError:"navigation_uncertain"})).toContain("before submitting again");
 });
});
