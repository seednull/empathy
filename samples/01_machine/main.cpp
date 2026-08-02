#include <empathy.h>
#include <cassert>

int main()
{
	Empathy_Instance instance = EMPATHY_NULL_HANDLE;

	Empathy_InstanceDesc instance_desc =
	{
	};

	Empathy_Result result = empathyCreateInstance(&instance_desc, &instance);
	assert(result == EMPATHY_SUCCESS);

	result = empathyDestroyInstance(instance);
	assert(result == EMPATHY_SUCCESS);

	return 0;
}
