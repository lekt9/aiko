import unittest
from evaluator import score, deliveries, summarize

START={'type':'MessageReceived','id':'t','at':1000}
def delivery(mid, at, final=True):
    return {'type':'AikoTelegramActionSettled','turn':'t','at':at,'result':{'action':'telegram_send','status':'delivered','providerId':str(mid),'final':final}}

class EvaluationTests(unittest.TestCase):
    def test_reaction_is_not_a_response(self):
        reaction=delivery(1,2000);reaction['result']['action']='telegram_react'
        result=score({'id':'reaction'},[START,reaction],[],end_ms=50000)
        self.assertEqual(result['final_messages'],0)
        self.assertEqual(result['max_silence_ms'],49000)
        self.assertFalse(result['objective_pass'])
    def test_duplicate_settlement_is_not_duplicate_final(self):
        one=delivery(4,5000)
        two={'type':'AikoDeliverySettled','turn':'t','at':5500,'result':{'status':'delivered','providerId':'4'}}
        self.assertEqual(len(deliveries([one,two])),1)
    def test_automation_chatter_does_not_improve_latency(self):
        observed=[{'id':9,'kind':'message','at':1100,'text':'unrelated'}, {'id':4,'kind':'message','at':41000,'text':'42'}]
        result=score({'id':'math','exact':'42'},[START,delivery(4,40000)],observed,end_ms=42000)
        self.assertEqual(result['first_message_ms'],40000)
        self.assertEqual(result['intermediate_messages'],0)
        self.assertTrue(result['objective_pass'])
    def test_receipt_without_client_visibility_is_not_e2e_success(self):
        result=score({'id':'missing'},[START,delivery(4,5000)],[],end_ms=20000)
        self.assertIsNone(result['first_message_ms'])
        self.assertFalse(result['objective_pass'])
    def test_meaningful_progress_shortens_silence(self):
        observed=[{'id':2,'kind':'message','at':4000,'text':'Checking the page'}, {'id':4,'kind':'message','at':40000,'text':'Found it'}]
        result=score({'id':'progress'},[START,delivery(2,3500,False),delivery(4,39000)],observed,end_ms=40000)
        self.assertEqual(result['first_message_ms'],3000)
        self.assertEqual(result['completion_ms'],39000)
        self.assertEqual(result['max_silence_ms'],36000)
        self.assertEqual(result['intermediate_messages'],1)
    def test_final_flag_is_needed_to_claim_completion(self):
        result=score({'id':'running'},[START,delivery(2,3500,False)],[{'id':2,'kind':'message','at':4000,'text':'Working'}],end_ms=50000)
        self.assertIsNone(result['completion_ms'])
        self.assertIn('no_confirmed_final_reply',result['ux_flags'])
    def test_raw_private_job_pointer_does_not_prove_completion(self):
        native={'type':'AikoCodeToolSettled','tool':'sandbox_job','succeeded':True,'result':{'kind':'aiko-code-value'}}
        result=score({'id':'compute','compute':True},[START,delivery(4,5000),native],[{'id':4,'kind':'message','at':6000,'text':'done'}])
        self.assertIsNone(result['objective_pass'])
        self.assertTrue(result['needs_review'])
    def test_json_checks_reject_fences_and_wrong_values(self):
        for text,expected in [('```json\n[1]\n```',False),('[2]',False),('[1]',True)]:
            result=score({'id':'json','json':[1]},[START,delivery(4,5000)],[{'id':4,'kind':'message','at':6000,'text':text}])
            self.assertEqual(result['objective_pass'],expected)
    def test_missing_replies_do_not_become_zero_latency(self):
        missing=score(None,[START],[],end_ms=50000)
        summary=summarize([missing])
        self.assertIsNone(summary['completion_p50_ms'])
        self.assertEqual(summary['silent_or_unconfirmed_turns'],1)
    def test_no_intermediate_penalty_for_quick_answer(self):
        result=score({'id':'fast'},[START,delivery(4,5000)],[{'id':4,'kind':'message','at':6000,'text':'Hello'}])
        self.assertNotIn('long_task_without_intermediate_message',result['ux_flags'])
    def test_failed_native_tool_is_counted(self):
        result=score(None,[START,{'type':'AikoCodeToolSettled','tool':'agent_browser_url','succeeded':False}])
        self.assertEqual(result['tool_errors'][0]['tool'],'agent_browser_url')

if __name__=='__main__':unittest.main()

class NamespaceCorrelationTests(unittest.TestCase):
    def test_user_message_correlates_without_equal_bot_message_id(self):
        from evaluator import correlate_inbound
        event={'type':'MessageReceived','id':'telegram:9','source':'telegram','chat':'owner','telegram':{'messageId':1141,'sentAt':1000,'text':'Read the page'}}
        self.assertEqual(correlate_inbound([event],'owner','Read the page',1000)['id'],'telegram:9')
        self.assertIsNone(correlate_inbound([event],'other','Read the page',1000))
        self.assertIsNone(correlate_inbound([event,event],'owner','Read the page',1000))
    def test_client_ids_map_by_content_time_and_reply(self):
        from evaluator import correlate_deliveries
        prepared={'type':'AikoReplyPrepared','result':{'text':'42'},'at':4000}
        sent={'type':'AikoDeliverySettled','result':{'status':'delivered','providerId':'1142'},'at':5100}
        message={'kind':'message','id':249850,'at':5500,'server_at':5000,'reply_to':249849,'text':'42'}
        matched=correlate_deliveries([prepared,sent],[message],249849)
        self.assertEqual(matched[0]['provider_id'],'1142')
        self.assertEqual(matched[0]['id'],'249850')
        self.assertEqual(matched[0]['at'],5500)
        self.assertEqual(correlate_deliveries([prepared,sent],[message],1),[])
        self.assertEqual(correlate_deliveries([prepared,sent],[message,{**message,'id':2}],249849),[])
    def test_unrelated_content_cannot_pass_even_with_same_numeric_id(self):
        from evaluator import correlate_deliveries
        sent=delivery(4,5000);sent['result']['reply']='actual answer'
        self.assertEqual(correlate_deliveries([sent],[{'kind':'message','id':4,'at':5100,'server_at':5000,'text':'unrelated'}]),[])
